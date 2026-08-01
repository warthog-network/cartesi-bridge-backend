console.log("[cartesi-bridge-backend] dApp starting — vaults, sub_lock/sweep, ETH/ERC20, liquid mint");

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const { Wallet } = require("cartesi-wallet");
const { stringToHex, hexToString } = require("viem");
const wartSpv = require("./wartSpv");
const {
  isWartSpvInput,
  createLightClient,
  applyHeaders,
  verifyDepositClaim,
  lcSnapshot,
  hexNorm: spvHexNorm,
} = wartSpv;

/** Phase 3 Warthog light client (headers + SPV deposits). */
const wartLc = createLightClient({
  poolAccountId: Number(process.env.FUNGIBLE_POOL_ACCOUNT_ID || 81),
  minConfirmations: Number(process.env.WART_SPV_MIN_CONF || 1),
  allowBootstrap: process.env.WART_SPV_ALLOW_BOOTSTRAP !== "0",
  maxHeaders: Number(process.env.WART_SPV_MAX_HEADERS || 512),
});
/** When 1, naked pool_deposit (host JSON) is rejected — SPV only. Default 0 for lab. */
const POOL_REQUIRE_SPV = process.env.POOL_REQUIRE_SPV === "1";
// cartesi-wallet internal balance map (optional helper paths)
const wallet = new Wallet(new Map());

/**
 * Spendable Warthog vault model (see zk-proof-generator.rs):
 * - Client derives vault keypair offline: secret(mnemonic) + subAddress + index
 * - Machine stores public vaultAddress + lock policy only (no mnemonic/secret)
 * - Locked = collateral for minted spoofed wWART; unlock after burn/return
 * - After unlock notice, owner spends vault with client-derived private key
 */
const ZK_BIN_CANDIDATES = [
  process.env.ZK_PROOF_GENERATOR,
  "/opt/cartesi/bin/zk-proof-generator",
  path.join(__dirname, "..", "target", "release", "zk-proof-generator"),
  path.join(__dirname, "zk-proof-generator"),
].filter(Boolean);

function resolveZkBin() {
  for (const p of ZK_BIN_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return ZK_BIN_CANDIDATES[0] || "zk-proof-generator";
}

function isWartAddressHex(addr) {
  const h = String(addr || "")
    .replace(/^0x/i, "")
    .toLowerCase();
  return (h.length === 40 || h.length === 48) && /^[0-9a-f]+$/.test(h);
}

/**
 * Prefer client-provided spendable vaultAddress (secret-derived).
 * Fallback: Rust binary legacy commitment (sub+index only) — not spendable.
 */
function deriveVaultAddressRust(subAddress, subIndex, secretOpt) {
  const bin = resolveZkBin();
  const args = [
    "--sub-address",
    String(subAddress).replace(/^0x/i, ""),
    "--index",
    String(subIndex),
  ];
  if (secretOpt) {
    args.push("--secret", String(secretOpt));
  }
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        console.error("ZK binary failed:", stderr || error.message);
        return reject(error);
      }
      const line = String(stdout || "")
        .trim()
        .split("\n")
        .find((l) => l.startsWith("0x"));
      if (!line) return reject(new Error("No valid ZK output"));
      resolve(line.slice(2).toLowerCase());
    });
  });
}

async function resolveVaultAddress({ vaultAddress, subAddress, subIndex }) {
  if (vaultAddress && isWartAddressHex(vaultAddress)) {
    return String(vaultAddress).replace(/^0x/i, "").toLowerCase();
  }
  // Legacy machine-side commitment (no user secret available on rollup)
  return deriveVaultAddressRust(subAddress, subIndex, null);
}

// === TOKEN ADDRESSES (local Anvil / Sepolia — override via notices in prod) ===
// WWART is not deployed on local stack yet — deposits ignored until set to a real address.
const WWART_ADDRESS = (process.env.WWART_ADDRESS || "0x663F3ad617193148711d28f5334eE4Ed07016602").toLowerCase();
const CTSI_ADDRESS = (process.env.CTSI_ADDRESS || "0xae7f61eCf06C65405560166b259C54031428A9C4").toLowerCase();
const USDC_ADDRESS = (process.env.USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").toLowerCase();

// === PORTAL ADDRESSES (Cartesi CLI 1.5 local Anvil defaults) ===
const EtherPortal = "0xFfdbe43d4c855BF7e0f105c400A50857f53AB044".toLowerCase();
// Correct local ERC20Portal (was a fake placeholder)
const ERC20Portal = "0x9C21AEb2093C32DDbC53eEF24B873BDCd1aDa1DB".toLowerCase();
const dAppAddressRelay = "0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE".toLowerCase();

// === GLOBAL STATE ===
const userVaults = new Map();
let registeredUsers = new Map();
let dAppAddress = "";
let subLocks = new Map();
let pendingLocks = new Map();
const userMintHistories = new Map();
const userBurnHistories = new Map();
/** L1 owner → personal vault metadata (native token link) */
const personalVaults = new Map();

/**
 * ETH bridge sub-wallets (first step ETH → WART).
 * ethSubByAddress: ethAddress(lower) → { owner, index, address }
 * ethSubsByOwner:  owner(lower) → Map(index → { address, ethWei })
 * Portal ETH deposited from a registered sub credits owner vault.eth + sub ethWei.
 * Does NOT affect WART mint capacity.
 */
const ethSubByAddress = new Map();
const ethSubsByOwner = new Map();

/**
 * Cosigner ETH vaults (eth-2p-ecdsa-lindell-v1).
 * ethVaultByAddress: vaultEth → metadata
 * ethVaultsByOwner: owner → list of vault records
 * Locked ETH capacity is SEPARATE from WART mint capacity.
 * wETH claims (rollup) are temporary until Warthog DeFi WETH exists.
 */
const ethVaultByAddress = new Map();
const ethVaultsByOwner = new Map();
/** eth vault → release tickets for future cosign ETH withdraw */
const ethVaultReleaseState = new Map();

/**
 * Per-vault collateral policy for cosigner release tickets (Phase 3).
 * vaultAddress (wart hex) → { nextNonce, cumulativeBurnedE8, tickets: [...] }
 */
const vaultReleaseState = new Map();

/**
 * Path A — fungible shared pool (SEPARATE from personal 2P cosigner vaults).
 * Real WART lands on FUNGIBLE_POOL_ADDRESS; capacity is global; claims are per L1 owner.
 */
const FUNGIBLE_POOL_ADDRESS = String(
  process.env.FUNGIBLE_POOL_ADDRESS ||
    "966d1012941b1fb41d4fff2cadefca7115237dc1818a7cd7",
)
  .replace(/^0x/i, "")
  .toLowerCase();
const fungiblePool = {
  poolId: "wart-pool-0",
  poolAddress: FUNGIBLE_POOL_ADDRESS,
  lockedE8: 0n,
  claimed18: 0n,
  redeemedE8: 0n,
  nextNonce: 1,
  /** owner(lower) → { depositedE8, claim18, portable18, redeemedE8 } */
  users: new Map(),
  /** credited Warthog tx hashes */
  usedDepositTxs: new Set(),
  tickets: [],
};
console.log(
  "[fungible-pool] Path A pool address:",
  fungiblePool.poolAddress,
  "(personal cosigner vaults unchanged)",
);

function ensurePoolUser(owner) {
  const o = String(owner || "").toLowerCase();
  let u = fungiblePool.users.get(o);
  if (!u) {
    u = {
      depositedE8: 0n,
      claim18: 0n,
      portable18: 0n,
      redeemedE8: 0n,
    };
    fungiblePool.users.set(o, u);
  }
  return u;
}

function poolCapacity18() {
  return fungiblePool.lockedE8 * 10n ** 10n;
}

function poolAvailable18() {
  const c = poolCapacity18();
  const u = fungiblePool.claimed18;
  return c > u ? c - u : 0n;
}

/** Open claims → E8 floor (1 WART claim = 1e18 → 1e8 E8). */
function claimedToE8(claimed18) {
  return BigInt(claimed18 || 0n) / 10n ** 10n;
}

/**
 * Global freeable WART (E8): locked collateral not required for open claims.
 * freeable = lockedE8 − floor(claimed18 / 1e10)
 */
function poolFreeableE8() {
  const need = claimedToE8(fungiblePool.claimed18);
  return fungiblePool.lockedE8 > need
    ? fungiblePool.lockedE8 - need
    : 0n;
}

/**
 * User freeable deposit (E8): min(user.depositedE8, global freeable).
 * After burn of filled claims this is what can be paid out without an open portable claim.
 */
function userFreeableE8(owner) {
  const pu = ensurePoolUser(owner);
  const g = poolFreeableE8();
  return pu.depositedE8 < g ? pu.depositedE8 : g;
}

/**
 * Debit depositors FIFO when holder redeem spends collateral not only the redeemer's.
 * Prefer `preferOwner` first, then Map insertion order. Throws if accounting shortfall.
 * @returns {{ owner: string, e8: string }[]}
 */
function debitDepositsFifo(e8, preferOwner = null) {
  let left = BigInt(e8);
  const debits = [];
  if (left <= 0n) return debits;

  const take = (owner) => {
    if (left <= 0n) return;
    const o = String(owner || "").toLowerCase();
    if (!o) return;
    const pu = ensurePoolUser(o);
    if (pu.depositedE8 <= 0n) return;
    const d = pu.depositedE8 < left ? pu.depositedE8 : left;
    pu.depositedE8 -= d;
    left -= d;
    if (d > 0n) debits.push({ owner: o, e8: d.toString() });
  };

  if (preferOwner) take(preferOwner);
  for (const [owner] of fungiblePool.users) {
    if (
      preferOwner &&
      owner === String(preferOwner).toLowerCase()
    ) {
      continue;
    }
    take(owner);
    if (left <= 0n) break;
  }
  if (left > 0n) {
    throw new Error(
      `debitDepositsFifo: shortfall ${left} E8 (sum deposited < locked spend)`,
    );
  }
  return debits;
}

/**
 * Debit filled personal pool claims (claim − portable) when a bearer burns wWART (A-β).
 * Soft: logs and returns partial debits if personal maps lag global claimed.
 * @returns {{ owner: string, amount18: string }[]}
 */
function debitFilledClaimsFifo(amount18, preferOwner = null) {
  let left = BigInt(amount18);
  const debits = [];
  if (left <= 0n) return debits;

  const take = (owner) => {
    if (left <= 0n) return;
    const o = String(owner || "").toLowerCase();
    if (!o) return;
    const vault = userVaults.get(o);
    const pu = ensurePoolUser(o);
    const claim = vault
      ? vault.poolL1WwartClaim || 0n
      : pu.claim18 || 0n;
    const portable = vault
      ? vault.poolWwartPortable || 0n
      : pu.portable18 || 0n;
    const filled = filledClaim18(claim, portable);
    if (filled <= 0n) return;
    const d = filled < left ? filled : left;
    if (vault) {
      vault.poolL1WwartClaim = claim - d;
      userVaults.set(o, vault);
    }
    if (pu.claim18 >= d) pu.claim18 -= d;
    else pu.claim18 = 0n;
    left -= d;
    debits.push({ owner: o, amount18: d.toString() });
  };

  if (preferOwner) take(preferOwner);
  for (const [owner] of fungiblePool.users) {
    if (
      preferOwner &&
      owner === String(preferOwner).toLowerCase()
    ) {
      continue;
    }
    take(owner);
    if (left <= 0n) break;
  }
  if (left > 0n) {
    for (const [owner] of userVaults) {
      if (
        preferOwner &&
        owner === String(preferOwner).toLowerCase()
      ) {
        continue;
      }
      take(owner);
      if (left <= 0n) break;
    }
  }
  if (left > 0n) {
    console.warn(
      `[debitFilledClaimsFifo] personal claim shortfall ${left} (global claimed already authoritative)`,
    );
  }
  return debits;
}

function poolSnapshot(owner = null) {
  const freeableE8 = poolFreeableE8();
  const snap = {
    poolId: fungiblePool.poolId,
    poolAddress: fungiblePool.poolAddress,
    scheme: "wart-fungible-pool-v0",
    redeemPhase: "A-beta",
    holderRedeem: true,
    spv: {
      requireSpv: POOL_REQUIRE_SPV,
      ...lcSnapshot(wartLc),
    },
    lockedE8: fungiblePool.lockedE8.toString(),
    capacity18: poolCapacity18().toString(),
    claimed18: fungiblePool.claimed18.toString(),
    available18: poolAvailable18().toString(),
    redeemedE8: fungiblePool.redeemedE8.toString(),
    freeableE8: freeableE8.toString(),
    nextNonce: fungiblePool.nextNonce,
    recentTickets: fungiblePool.tickets.slice(-10),
  };
  if (owner) {
    const o = String(owner).toLowerCase();
    const u = fungiblePool.users.get(o);
    const userFree = userFreeableE8(o);
    snap.user = u
      ? {
          owner: o,
          depositedE8: u.depositedE8.toString(),
          claim18: u.claim18.toString(),
          portable18: u.portable18.toString(),
          redeemedE8: u.redeemedE8.toString(),
          freeableE8: userFree.toString(),
        }
      : {
          owner: o,
          depositedE8: "0",
          claim18: "0",
          portable18: "0",
          redeemedE8: "0",
          freeableE8: "0",
        };
  }
  return snap;
}

/**
 * Release locked pool WART + emit pool_release_ticket for hot-wallet payout.
 * Caller must ensure amtE8 ≤ freeable / accounting invariants.
 * @returns {object} ticket
 */
async function issuePoolReleaseTicket({
  user,
  amtE8,
  amount18 = null,
  toAddress = null,
  reason = "unlock",
}) {
  const owner = String(user || "").toLowerCase();
  const e8 = BigInt(amtE8);
  if (e8 <= 0n) throw new Error("issuePoolReleaseTicket: amtE8 must be > 0");
  if (fungiblePool.lockedE8 < e8) {
    throw new Error("issuePoolReleaseTicket: insufficient lockedE8");
  }

  fungiblePool.lockedE8 -= e8;
  fungiblePool.redeemedE8 += e8;
  // Collateral attribution: redeemer first, then FIFO other depositors (A-β holder redeem).
  let depositDebits = [];
  try {
    depositDebits = debitDepositsFifo(e8, owner);
  } catch (e) {
    // Roll back locked if deposit map cannot cover (should not happen if invariants hold).
    fungiblePool.lockedE8 += e8;
    fungiblePool.redeemedE8 -= e8;
    throw e;
  }
  const pu = ensurePoolUser(owner);
  pu.redeemedE8 += e8;

  const isBeta =
    reason === "holder-burn-unlock" || reason === "holder-redeem";
  const nonce = fungiblePool.nextNonce++;
  const ticketId = `${fungiblePool.poolId}:${nonce}`;
  const to =
    toAddress != null && String(toAddress).trim()
      ? String(toAddress).replace(/^0x/i, "").toLowerCase()
      : null;
  const amount18Str =
    amount18 != null
      ? String(amount18)
      : (e8 * 10n ** 10n).toString();
  const ticket = {
    type: "pool_release_ticket",
    scheme: "wart-pool-release-ticket-v0",
    ticketId,
    nonce,
    poolId: fungiblePool.poolId,
    poolAddress: fungiblePool.poolAddress,
    owner,
    toAddress: to,
    amountE8: e8.toString(),
    amount18: amount18Str,
    phase: isBeta ? "A-beta" : "A-alpha",
    source: "pool",
    reason,
    depositDebits,
    message:
      reason === "holder-burn-unlock" || reason === "holder-redeem"
        ? "Path A A-β holder redeem — any wWART bearer may burn portal inventory; hot wallet pays amountE8 WART to toAddress"
        : reason === "portable-redeem"
          ? "Path A redeem ticket — hot wallet may pay amountE8 WART from pool address to toAddress"
          : "Path A unlock ticket — free headroom after burn/claim closed; hot wallet pays amountE8 WART",
  };
  fungiblePool.tickets.push(ticket);
  if (fungiblePool.tickets.length > 200) {
    fungiblePool.tickets = fungiblePool.tickets.slice(-200);
  }
  await sendNotice(stringToHex(JSON.stringify(ticket)));
  return ticket;
}

/**
 * Portal ERC-20 wWART is 18-dec. Legacy sweeps wrote spoofed E8 into wWART —
 * never treat values below 1e15 as real portal inventory.
 */
function portalWwart18Of(raw) {
  const w = BigInt(raw || 0n);
  if (w > 0n && w < 10n ** 15n) return 0n;
  return w;
}

/** Filled claim still on L1 = claim − portable (not yet returned). */
function filledClaim18(claim, portable) {
  const c = BigInt(claim || 0n);
  const p = BigInt(portable || 0n);
  const open = p < c ? p : c;
  return c > open ? c - open : 0n;
}

/**
 * Credit portal-deposited wWART into path-isolated buckets.
 * - vault.wWART          = Path B (personal) portal inventory
 * - vault.poolPortalWwart = Path A (pool) portal inventory
 * pathHint: "pool" | "personal" | null (auto)
 * Auto: fill pool filled shortfall first, then personal (keeps Path A reverse working).
 * @returns {{ path: string, poolCredited: bigint, personalCredited: bigint }}
 */
function creditWwartPortal(vault, amount, pathHint = null) {
  const amt = BigInt(amount || 0n);
  if (amt <= 0n) {
    return { path: "none", poolCredited: 0n, personalCredited: 0n };
  }
  const hint = pathHint ? String(pathHint).toLowerCase().trim() : "";
  if (hint === "pool" || hint === "a" || hint === "path-a") {
    vault.poolPortalWwart = (vault.poolPortalWwart || 0n) + amt;
    return { path: "pool", poolCredited: amt, personalCredited: 0n };
  }
  if (hint === "personal" || hint === "b" || hint === "path-b" || hint === "vault") {
    vault.wWART = portalWwart18Of(vault.wWART) + amt;
    return { path: "personal", poolCredited: 0n, personalCredited: amt };
  }

  const poolFilled = filledClaim18(
    vault.poolL1WwartClaim,
    vault.poolWwartPortable,
  );
  const personalFilled = filledClaim18(vault.l1WwartClaim, vault.wwartPortable);

  // Only personal filled (or neither with no pool claim) → personal
  if (poolFilled === 0n && personalFilled > 0n) {
    vault.wWART = portalWwart18Of(vault.wWART) + amt;
    return { path: "personal", poolCredited: 0n, personalCredited: amt };
  }
  // Only pool filled → pool (Path A reverse deposit)
  if (personalFilled === 0n && poolFilled > 0n) {
    vault.poolPortalWwart = (vault.poolPortalWwart || 0n) + amt;
    return { path: "pool", poolCredited: amt, personalCredited: 0n };
  }
  // Both filled: cover pool shortfall first, remainder personal
  if (poolFilled > 0n && personalFilled > 0n) {
    const toPool = amt < poolFilled ? amt : poolFilled;
    const toPersonal = amt - toPool;
    if (toPool > 0n) {
      vault.poolPortalWwart = (vault.poolPortalWwart || 0n) + toPool;
    }
    if (toPersonal > 0n) {
      vault.wWART = portalWwart18Of(vault.wWART) + toPersonal;
    }
    return {
      path: "split",
      poolCredited: toPool,
      personalCredited: toPersonal,
    };
  }
  // No filled claims on this L1 owner:
  // A-β — if the pool has open global claims, credit Path A portal so a bearer
  // who bought wWART can burn/redeem without having minted themselves.
  if (fungiblePool.claimed18 > 0n) {
    vault.poolPortalWwart = (vault.poolPortalWwart || 0n) + amt;
    return { path: "pool", poolCredited: amt, personalCredited: 0n };
  }
  // Idle pool: default personal (Path B)
  vault.wWART = portalWwart18Of(vault.wWART) + amt;
  return { path: "personal", poolCredited: 0n, personalCredited: amt };
}

/** Optional path tag from ERC20 portal exec layer data (after amount). */
function parsePortalPathHint(payloadHex, amountEndOffsetBytes) {
  try {
    const hex = String(payloadHex || "").replace(/^0x/i, "").toLowerCase();
    const o = amountEndOffsetBytes * 2;
    if (hex.length <= o) return null;
    const rest = hex.slice(o);
    if (!rest || rest.length < 2) return null;
    let text = "";
    try {
      text = Buffer.from(rest, "hex").toString("utf8").replace(/\0/g, "").trim();
    } catch {
      return null;
    }
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes("pool") || lower === "a" || lower.includes("path-a")) {
      return "pool";
    }
    if (
      lower.includes("personal") ||
      lower.includes("vault") ||
      lower === "b" ||
      lower.includes("path-b")
    ) {
      return "personal";
    }
    try {
      const j = JSON.parse(text);
      if (j?.path) return String(j.path).toLowerCase();
    } catch {
      /* not json */
    }
    return null;
  } catch {
    return null;
  }
}

function ensureUserVaultShell(user) {
  const u = String(user || "").toLowerCase();
  let v = userVaults.get(u);
  if (!v) {
    v = {
      liquid: 0n,
      /** Path B personal portal wWART inventory (18-dec) */
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n,
      l1WwartClaim: 0n,
      wwartPortable: 0n,
      /** Path A pool claims — not personal vault capacity */
      poolL1WwartClaim: 0n,
      poolWwartPortable: 0n,
      /** Path A portal-returned wWART (18-dec) — isolated from personal wWART */
      poolPortalWwart: 0n,
      ethLockedMinted: 0n,
      ethLockedBurned: 0n,
      l1WethClaim: 0n,
      wethPortable: 0n,
      /** Native Warthog ETH assets linked to mint amounts (client createAssets) */
      ethWartAssets: [],
    };
    userVaults.set(u, v);
  } else {
    if (v.ethLockedMinted == null) v.ethLockedMinted = 0n;
    if (v.ethLockedBurned == null) v.ethLockedBurned = 0n;
    if (v.l1WethClaim == null) v.l1WethClaim = 0n;
    if (v.wethPortable == null) v.wethPortable = 0n;
    if (v.poolL1WwartClaim == null) v.poolL1WwartClaim = 0n;
    if (v.poolWwartPortable == null) v.poolWwartPortable = 0n;
    if (v.poolPortalWwart == null) v.poolPortalWwart = 0n;
    if (!Array.isArray(v.ethWartAssets)) v.ethWartAssets = [];
  }
  if (!Array.isArray(v.ethWartAssets)) v.ethWartAssets = [];
  return v;
}

/** Locked ETH outstanding (wei) → capacity for wETH claims only. */
function ethLockedOutstandingWei(vault) {
  const m = vault?.ethLockedMinted || 0n;
  const b = vault?.ethLockedBurned || 0n;
  return m > b ? m - b : 0n;
}

function ethBackingCapacity18(vault) {
  return ethLockedOutstandingWei(vault);
}

function ethShareClaimed18(vault) {
  return vault?.l1WethClaim || 0n;
}

const rollupServer = process.env.ROLLUP_HTTP_SERVER_URL;
console.log("HTTP rollup_server url:", rollupServer);

// Helpers
const sendNotice = async (payload) => {
  try {
    await fetch(`${rollupServer}/notice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    console.error("Notice failed:", e);
  }
};

/** Flatten DeFi testnet v0.10+ lookup proofs to legacy fields sub_lock expects. */
function normalizeWarthogTx(proof) {
  const tx = proof?.transaction;
  if (!tx) return null;
  if (tx.toAddress != null && tx.amountE8 != null) return tx;

  const data = tx.data || {};
  const common = tx.signedCommon || tx.signingData || {};
  const amountObj = data.amount || {};

  return {
    txHash: tx.hash || tx.txHash,
    fromAddress: common.originAddress || data.fromAddress || tx.fromAddress || null,
    toAddress: data.toAddress || tx.toAddress,
    amountE8: Number(amountObj.E8 ?? amountObj.u64 ?? data.amountE8 ?? tx.amountE8 ?? 0),
    blockHeight: proof.mined?.block?.height ?? tx.blockHeight,
    confirmations: proof.confirmations ?? tx.confirmations,
  };
}

const sendReport = async (payload) => {
  try {
    await fetch(`${rollupServer}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    console.error("Report failed:", e);
  }
};

const formatEther = (wei) => {
  if (wei === 0n) return "0.0";
  const str = wei.toString();
  const integerPart = str.length > 18 ? str.slice(0, str.length - 18) : "0";
  let fractionalPart = str.length > 18 ? str.slice(str.length - 18) : "0".repeat(18 - str.length) + str;
  fractionalPart = fractionalPart.replace(/0+$/, "");
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
};

// =============================================================================
// ETH MODULE ──────────────────────────────────────────────────────────────────
// All ETH deposit / withdraw logic lives here
// =============================================================================

const ETH = {
  PORTAL_ADDRESS: EtherPortal,

  WITHDRAW_SELECTOR: "0x522f6815",          // withdrawEther(address to, uint256 amount)

  // ─── Deposit handling ─────────────────────────────────────────────────────
  parseDepositPayload(payload) {
    if (typeof payload !== 'string' || !payload.startsWith('0x') || payload.length !== 106) {
      console.log("ETH deposit payload has unexpected length/format");
      return null;
    }

    try {
      const data = payload.slice(2);
      const depositor = "0x" + data.slice(0, 40).toLowerCase();
      const amountHex = "0x" + data.slice(40);
      const amountWei = BigInt(amountHex);

      if (amountWei <= 0n || depositor === "0x0000000000000000000000000000000000000000") {
        return null;
      }

      return { depositor, amountWei };
    } catch (err) {
      console.error("ETH deposit payload parsing error:", err);
      return null;
    }
  },

  /**
   * Credit ETH inventory. If depositor is a registered eth sub-wallet,
   * attribute to the L1 owner vault + that sub index (not mint capacity).
   */
  creditToVault(vaults, depositor, amountWei) {
    const dep = String(depositor || "").toLowerCase();
    const sub = ethSubByAddress.get(dep);
    const creditUser = sub?.owner || dep;

    let vault = vaults.get(creditUser) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n,
      l1WwartClaim: 0n,
      wwartPortable: 0n,
    };
    vault.eth = (vault.eth || 0n) + amountWei;
    vaults.set(creditUser, vault);

    let subIndex = null;
    let subBalance = null;
    if (sub) {
      let byIdx = ethSubsByOwner.get(sub.owner);
      if (!byIdx) {
        byIdx = new Map();
        ethSubsByOwner.set(sub.owner, byIdx);
      }
      const cur = byIdx.get(sub.index) || {
        address: sub.address,
        ethWei: 0n,
      };
      cur.ethWei = (cur.ethWei || 0n) + amountWei;
      cur.address = sub.address;
      byIdx.set(sub.index, cur);
      subIndex = sub.index;
      subBalance = cur.ethWei.toString();
    }

    return {
      creditUser,
      subIndex,
      subBalance,
      newBalance: vault.eth.toString(),
    };
  },

  createDepositNotice(depositor, amountWei, creditMeta = null) {
    const meta = creditMeta || {};
    const user = meta.creditUser || depositor;
    const vault = userVaults.get(user);
    return {
      type: "eth_deposited",
      user,
      depositor,
      amount: amountWei.toString(),
      newBalance: meta.newBalance ?? vault?.eth?.toString() ?? "0",
      /** null unless depositor is a registered eth sub */
      ethSubIndex: meta.subIndex != null ? meta.subIndex : null,
      ethSubBalance: meta.subBalance != null ? meta.subBalance : null,
      message:
        meta.subIndex != null
          ? `ETH portal → owner via eth sub #${meta.subIndex} (inventory only, not WART mint capacity)`
          : "ETH portal inventory (not WART mint capacity)",
    };
  },

  // ─── Withdrawal handling ──────────────────────────────────────────────────
  buildWithdrawPayload(recipient, amountWei) {
    const recipientNo0x = recipient.slice(2).padStart(64, '0');
    const amountNo0x    = amountWei.toString(16).padStart(64, '0');

    return "0x" + ETH.WITHDRAW_SELECTOR.slice(2) + recipientNo0x + amountNo0x;
  },

  async emitVoucher(destination, payload) {
    const voucher = { destination, payload };
    const res = await fetch(`${rollupServer}/voucher`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(voucher),
    });

    if (!res.ok) {
      throw new Error(`Voucher emission failed: HTTP ${res.status}`);
    }
  },

  createWithdrawNotice(user, amountWei) {
    return {
      type: "eth_withdrawn",
      user,
      amount: formatEther(amountWei)
    };
  }
};

// ERC-20 vouchers:
//  - transfer: dApp already holds tokens (portal deposit path)
//  - mint: MinterWWART.onlyMinter — Application is msg.sender on executeVoucher,
//    so minter must be the Cartesi Application address
const ERC20 = {
  TRANSFER_SELECTOR: "0xa9059cbb", // transfer(address,uint256)
  MINT_SELECTOR: "0x40c10f19", // mint(address,uint256)

  buildTransferPayload(recipient, amount) {
    const to = String(recipient).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    const amt = BigInt(amount).toString(16).padStart(64, "0");
    return "0x" + this.TRANSFER_SELECTOR.slice(2) + to + amt;
  },

  buildMintPayload(recipient, amount) {
    const to = String(recipient).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    const amt = BigInt(amount).toString(16).padStart(64, "0");
    return "0x" + this.MINT_SELECTOR.slice(2) + to + amt;
  },

  async emitVoucher(tokenAddress, payload) {
    const res = await fetch(`${rollupServer}/voucher`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: tokenAddress, payload }),
    });
    if (!res.ok) {
      throw new Error(`ERC20 voucher failed: HTTP ${res.status}`);
    }
  },
};

/** Shared ERC-20 withdraw against custom userVaults map. */
async function withdrawErc20FromVault(user, tokenKey, tokenAddress, amount, noticeType) {
  let vault = userVaults.get(user);
  if (!vault) {
    console.log(`Insufficient ${tokenKey} balance (no vault)`);
    return "reject";
  }
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    console.log(`${tokenKey} token address not configured`);
    return "reject";
  }

  // wWART withdrawable = portable mint claims (18-dec) + real portal ERC-20 (18-dec).
  // Legacy sweep_lock wrote spoofed E8 into vault.wWART — never treat those as withdrawable.
  const portalWwart18 = (v) => {
    const w = v.wWART || 0n;
    // 1 WART portal = 1e18; spoofed E8 for 1 WART = 1e8. Values below 1e15 are E8 pollution.
    if (w > 0n && w < 10n ** 15n) return 0n;
    return w;
  };
  let available;
  if (tokenKey === "wWART") {
    available = (vault.wwartPortable || 0n) + portalWwart18(vault);
  } else {
    available = vault[tokenKey] || 0n;
  }
  if (available < amount) {
    console.log(`Insufficient ${tokenKey} balance have=${available} need=${amount}`);
    return "reject";
  }

  // Debit portable first for wWART, then base wWART (portal)
  let portableDebit = 0n;
  let baseDebit = 0n;
  if (tokenKey === "wWART") {
    const portable = vault.wwartPortable || 0n;
    const portal = portalWwart18(vault);
    portableDebit = portable >= amount ? amount : portable;
    baseDebit = amount - portableDebit;
    if (baseDebit > portal) {
      console.log(`Insufficient portal wWART have=${portal} need=${baseDebit}`);
      return "reject";
    }
    vault.wwartPortable = portable - portableDebit;
    // Only debit real portal 18-dec balance (leave any legacy E8 pollution alone / clear it)
    if (portal > 0n) {
      vault.wWART = portal - baseDebit;
    }
    // Capacity stays locked until burn_wwart / burn_wliq.
    // Withdraw only moves portable → L1 ERC-20 mirror; do NOT free l1WwartClaim.
    // (Previously freeing claim on withdraw made Available == Capacity after mint+withdraw.)
  } else {
    vault[tokenKey] -= amount;
  }
  userVaults.set(user, vault);

  try {
    // Portable wWART claims never sat in the dApp ERC-20 balance — mint on L1 via voucher.
    // Portal-deposited wWART (base) still transfers out of the dApp vault.
    if (tokenKey === "wWART") {
      if (portableDebit > 0n) {
        await ERC20.emitVoucher(
          tokenAddress,
          ERC20.buildMintPayload(user, portableDebit),
        );
      }
      if (baseDebit > 0n) {
        await ERC20.emitVoucher(
          tokenAddress,
          ERC20.buildTransferPayload(user, baseDebit),
        );
      }
    } else {
      const payload = ERC20.buildTransferPayload(user, amount);
      await ERC20.emitVoucher(tokenAddress, payload);
    }
    const newBal =
      tokenKey === "wWART"
        ? (
            (vault.wwartPortable || 0n) +
            // same portal-only rule as available (ignore legacy E8 pollution)
            ((vault.wWART || 0n) > 0n && (vault.wWART || 0n) < 10n ** 15n
              ? 0n
              : vault.wWART || 0n)
          ).toString()
        : vault[tokenKey].toString();
    await sendNotice(stringToHex(JSON.stringify({
      type: noticeType,
      user,
      amount: amount.toString(),
      newBalance: newBal,
      tokenAddress,
      portableMinted: tokenKey === "wWART" ? portableDebit.toString() : "0",
      portalTransferred: tokenKey === "wWART" ? baseDebit.toString() : amount.toString(),
      // Capacity claim stays; only portable moves to L1
      l1WwartClaim:
        tokenKey === "wWART" ? (vault.l1WwartClaim || 0n).toString() : undefined,
      wwartPortable:
        tokenKey === "wWART" ? (vault.wwartPortable || 0n).toString() : undefined,
      message:
        tokenKey === "wWART" && portableDebit > 0n
          ? "L1 mint voucher emitted — execute voucher so MetaMask receives wWART. Capacity stays used until burn."
          : undefined,
    })));
    console.log(`*** ${tokenKey} WITHDRAWAL: ${amount} → ${user} ***`);
    return "accept";
  } catch (e) {
    // rollback
    if (tokenKey === "wWART") {
      vault.wwartPortable = (vault.wwartPortable || 0n) + portableDebit;
      vault.wWART = (vault.wWART || 0n) + baseDebit;
      // l1WwartClaim was never debited on withdraw — nothing to restore for capacity
    } else {
      vault[tokenKey] += amount;
    }
    userVaults.set(user, vault);
    console.error(`${tokenKey} withdraw failed:`, e.message);
    return "reject";
  }
}

// === ADVANCE STATE HANDLER ===
const handleAdvance = async (request) => {
  const payload = request.payload;
  const sender = request.metadata.msg_sender.toLowerCase();

  let input = null;
  if (payload && payload.startsWith("0x")) {
    try {
      const decoded = hexToString(payload);
      input = JSON.parse(decoded);
      console.log("Parsed input:", input);
    } catch (e) {
      console.log("Payload is not JSON (probably portal deposit)");
    }
  }

  // 1. DApp Address Relay
  if (sender === dAppAddressRelay) {
    dAppAddress = payload;
    console.log("DApp address relayed:", dAppAddress);
    return "accept";
  }

  // Phase 3 SPV — light client headers + deposit claims
  if (isWartSpvInput(input)) {
    try {
      if (input.type === "wart_checkpoint" || (input.type === "wart_headers" && input.bootstrap)) {
        const headers = input.headers || (input.header ? [input.header] : []);
        if (!headers.length && input.checkpointHash) {
          // Minimal checkpoint without full window
          wartLc.bootstrapped = true;
          wartLc.checkpointHeight = Number(input.checkpointHeight || input.height || 0);
          wartLc.checkpointHash = spvHexNorm(input.checkpointHash);
          wartLc.bestHeight = wartLc.checkpointHeight;
          wartLc.bestHash = wartLc.checkpointHash;
          wartLc.byHeight.set(wartLc.checkpointHeight, {
            hash: wartLc.bestHash,
            prevHash: spvHexNorm(input.prevHash || "00".repeat(32)),
            merkleroot: spvHexNorm(input.merkleroot || "00".repeat(32)),
          });
          if (input.pinHeight != null) wartLc.pinHeight = Number(input.pinHeight);
          if (input.pinHash) wartLc.pinHash = spvHexNorm(input.pinHash);
        } else {
          applyHeaders(wartLc, headers, {
            bootstrap: true,
            pinHeight: input.pinHeight,
            pinHash: input.pinHash,
          });
        }
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "wart_headers_applied",
              bootstrap: true,
              ...lcSnapshot(wartLc),
            }),
          ),
        );
        console.log("[wart_spv] bootstrapped / headers", lcSnapshot(wartLc));
        return "accept";
      }

      if (input.type === "wart_headers") {
        applyHeaders(wartLc, input.headers || [], {
          bootstrap: false,
          pinHeight: input.pinHeight,
          pinHash: input.pinHash,
        });
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "wart_headers_applied",
              bootstrap: false,
              ...lcSnapshot(wartLc),
            }),
          ),
        );
        console.log("[wart_spv] headers applied tip", wartLc.bestHeight);
        return "accept";
      }

      if (input.type === "wart_deposit_claim") {
        const owner = String(input.owner || sender || "").toLowerCase();
        if (!owner.startsWith("0x") || owner.length !== 42) {
          throw new Error("wart_deposit_claim requires owner L1 address");
        }
        const credit = verifyDepositClaim(input, wartLc, {
          poolAccountId: wartLc.poolAccountId,
        });
        const txKey = credit.txKey;
        if (fungiblePool.usedDepositTxs.has(txKey)) {
          throw new Error(`duplicate deposit txKey ${txKey.slice(0, 16)}`);
        }
        const amtE8 = credit.amountE8n;
        fungiblePool.usedDepositTxs.add(txKey);
        // Also mark human-readable hash if provided
        if (input.txHash || input.tx?.hash) {
          fungiblePool.usedDepositTxs.add(
            spvHexNorm(input.txHash || input.tx.hash),
          );
        }
        fungiblePool.lockedE8 += amtE8;
        const pu = ensurePoolUser(owner);
        pu.depositedE8 += amtE8;
        ensureUserVaultShell(owner);

        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "pool_deposit",
              scheme: "wart-deposit-claim-v0",
              verification: "spv-v0",
              ...poolSnapshot(owner),
              owner,
              amountE8: amtE8.toString(),
              fromAccountId: credit.originAccountId,
              toAccountId: credit.toAccountId,
              txHash: input.txHash || input.tx?.hash || txKey,
              txKey,
              blockHeight: credit.blockHeight,
              headerHash: credit.headerHash,
              confirmations: credit.confirmations,
              source: "pool",
              lc: lcSnapshot(wartLc),
              message:
                "SPV-verified WART deposit to pool — mint headroom increased (Path A)",
            }),
          ),
        );
        console.log(
          `[wart_deposit_claim] ${owner} +${amtE8} E8 h=${credit.blockHeight} locked=${fungiblePool.lockedE8}`,
        );
        return "accept";
      }

      throw new Error(`unknown SPV input ${input.type}`);
    } catch (e) {
      console.log(`[wart_spv] reject: ${e?.message || e}`);
      try {
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "wart_spv_rejected",
              reason: e?.message || String(e),
              inputType: input?.type || null,
              lc: lcSnapshot(wartLc),
            }),
          ),
        );
      } catch {
        /* ignore */
      }
      return "reject";
    }
  }

  // 2. USER REGISTERS THEIR ADDRESS (idempotent)
  if (input?.type === "register_address") {
    const user = String(sender || "").toLowerCase();
    const already = registeredUsers.has(user) && registeredUsers.get(user) === true;
    registeredUsers.set(user, true);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "address_registered",
          user,
          alreadyRegistered: already,
        }),
      ),
    );
    console.log(
      already
        ? "register_address already registered:"
        : "Received register_address from",
      user,
    );
    return "accept";
  }

  /**
   * register_eth_sub — bind an HD ETH deposit address (indexed) to this L1 owner.
   * First step of ETH → WART bridge: deposit addresses with index like WART subs.
   * Portal ETH from that address credits owner inventory (not WART mint capacity).
   *
   * input: { type, index, ethAddress, path? }
   */
  if (input?.type === "register_eth_sub" || input?.type === "eth_sub_register") {
    const owner = String(sender || "").toLowerCase();
    const index = Number(input.index);
    const ethAddress = String(input.ethAddress || input.address || "")
      .toLowerCase();
    if (!Number.isFinite(index) || index < 0 || index >= 0x80000000) {
      console.log("[register_eth_sub] bad index", input.index);
      return "reject";
    }
    if (!/^0x[0-9a-f]{40}$/.test(ethAddress)) {
      console.log("[register_eth_sub] bad ethAddress", input.ethAddress);
      return "reject";
    }
    const existing = ethSubByAddress.get(ethAddress);
    if (existing && existing.owner !== owner) {
      console.log(
        "[register_eth_sub] address already bound to another owner",
        ethAddress,
        existing.owner,
      );
      return "reject";
    }
    // Same owner re-register same index → update address if needed
    let byIdx = ethSubsByOwner.get(owner);
    if (!byIdx) {
      byIdx = new Map();
      ethSubsByOwner.set(owner, byIdx);
    }
    const prevAtIndex = byIdx.get(index);
    if (prevAtIndex && prevAtIndex.address !== ethAddress) {
      ethSubByAddress.delete(prevAtIndex.address);
    }
    const prevWei = prevAtIndex?.ethWei || 0n;
    const entry = {
      address: ethAddress,
      ethWei: prevWei,
      path: input.path ? String(input.path) : null,
    };
    byIdx.set(index, entry);
    ethSubByAddress.set(ethAddress, { owner, index, address: ethAddress });

    // Ensure owner vault exists (inventory shell; capacity stays 0 until WART lock)
    if (!userVaults.has(owner)) {
      userVaults.set(owner, {
        liquid: 0n,
        wWART: 0n,
        CTSI: 0n,
        usdc: 0n,
        eth: 0n,
        spoofedMinted: 0n,
        spoofedBurned: 0n,
        l1WwartClaim: 0n,
        wwartPortable: 0n,
      });
    }
    registeredUsers.set(owner, true);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "eth_sub_registered",
          user: owner,
          index,
          ethAddress,
          path: entry.path,
          ethWei: entry.ethWei.toString(),
          message:
            "ETH sub-wallet registered — fund this address, then portal-deposit; inventory only (not WART mint capacity)",
        }),
      ),
    );
    console.log(
      `[register_eth_sub] owner=${owner} index=${index} eth=${ethAddress}`,
    );
    return "accept";
  }

  /**
   * create_eth_vault — register a cosigner 2P ETH vault under this L1 owner.
   * input: { type, vaultAddress, ethSubAddress?, index?, scheme? }
   */
  if (input?.type === "create_eth_vault" || input?.type === "eth_vault_create") {
    const owner = String(sender || "").toLowerCase();
    const vaultAddress = String(input.vaultAddress || input.address || "")
      .toLowerCase();
    const ethSubAddress = input.ethSubAddress
      ? String(input.ethSubAddress).toLowerCase()
      : input.subAddress
        ? String(input.subAddress).toLowerCase()
        : null;
    const index =
      input.index != null && input.index !== ""
        ? Number(input.index)
        : null;
    if (!/^0x[0-9a-f]{40}$/.test(vaultAddress)) {
      console.log("[create_eth_vault] bad vaultAddress", input.vaultAddress);
      return "reject";
    }
    const existing = ethVaultByAddress.get(vaultAddress);
    if (existing && existing.owner !== owner) {
      console.log("[create_eth_vault] vault owned by another", vaultAddress);
      return "reject";
    }
    const rec = {
      vaultAddress,
      owner,
      ethSubAddress,
      index: Number.isFinite(index) ? index : null,
      scheme: input.scheme || "eth-2p-ecdsa-lindell-v1",
      lockedMinted: existing?.lockedMinted || 0n,
      lockedBurned: existing?.lockedBurned || 0n,
      createdAt: existing?.createdAt || Date.now(),
    };
    ethVaultByAddress.set(vaultAddress, rec);
    let list = ethVaultsByOwner.get(owner);
    if (!list) {
      list = [];
      ethVaultsByOwner.set(owner, list);
    }
    const i = list.findIndex((x) => x.vaultAddress === vaultAddress);
    if (i >= 0) list[i] = rec;
    else list.push(rec);

    ensureUserVaultShell(owner);
    registeredUsers.set(owner, true);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "eth_vault_created",
          user: owner,
          vaultAddress,
          ethSubAddress,
          index: rec.index,
          scheme: rec.scheme,
          message:
            "Cosigner ETH vault registered — fund vault, lock for ETH capacity, mint wETH claims (not WART capacity)",
        }),
      ),
    );
    console.log(
      `[create_eth_vault] owner=${owner} vault=${vaultAddress} index=${rec.index}`,
    );
    return "accept";
  }

  /**
   * eth_vault_lock — lock native ETH as ETH-side mint capacity (owner attestation for now).
   * Funds should already sit on the cosigner vault address on L1.
   * input: { type, vaultAddress, amount | amountWei }
   */
  if (input?.type === "eth_vault_lock" || input?.type === "lock_eth_vault") {
    const owner = String(sender || "").toLowerCase();
    const vaultAddress = String(input.vaultAddress || "").toLowerCase();
    const rec = ethVaultByAddress.get(vaultAddress);
    if (!rec || rec.owner !== owner) {
      console.log("[eth_vault_lock] unknown vault or not owner", vaultAddress);
      return "reject";
    }
    let amountWei = 0n;
    try {
      if (input.amountWei != null) amountWei = BigInt(String(input.amountWei));
      else if (input.amount != null) {
        // human ETH → wei
        const s = String(input.amount).trim();
        if (s.includes(".")) {
          const [w, f = ""] = s.split(".");
          const frac = (f + "000000000000000000").slice(0, 18);
          amountWei = BigInt(w || "0") * 10n ** 18n + BigInt(frac || "0");
        } else {
          amountWei = BigInt(s) * 10n ** 18n;
        }
      }
    } catch (e) {
      console.log("[eth_vault_lock] bad amount", e?.message);
      return "reject";
    }
    if (amountWei <= 0n) {
      console.log("[eth_vault_lock] non-positive");
      return "reject";
    }

    const vault = ensureUserVaultShell(owner);
    vault.ethLockedMinted = (vault.ethLockedMinted || 0n) + amountWei;
    rec.lockedMinted = (rec.lockedMinted || 0n) + amountWei;
    ethVaultByAddress.set(vaultAddress, rec);
    userVaults.set(owner, vault);

    const outstanding = ethLockedOutstandingWei(vault);
    const claimed = ethShareClaimed18(vault);
    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "eth_vault_locked",
          user: owner,
          vaultAddress,
          amountWei: amountWei.toString(),
          amount: formatEther(amountWei),
          ethLockedOutstanding: outstanding.toString(),
          ethCapacity18: outstanding.toString(),
          ethClaimed18: claimed.toString(),
          ethRemaining18: (outstanding > claimed
            ? outstanding - claimed
            : 0n
          ).toString(),
          message:
            "ETH locked as capacity (separate from WART). Mint wETH claims against this pool.",
        }),
      ),
    );
    console.log(
      `[eth_vault_lock] ${owner} +${formatEther(amountWei)} ETH capacity vault=${vaultAddress}`,
    );
    return "accept";
  }

  /**
   * eth_vault_unlock / release_eth — free locked ETH capacity (must leave claim covered).
   * Emits eth_release_ticket for future cosigner ETH withdraw policy.
   */
  if (
    input?.type === "eth_vault_unlock" ||
    input?.type === "release_eth" ||
    input?.type === "unlock_eth_vault"
  ) {
    const owner = String(sender || "").toLowerCase();
    const vaultAddress = String(input.vaultAddress || "").toLowerCase();
    const rec = ethVaultByAddress.get(vaultAddress);
    if (!rec || rec.owner !== owner) {
      console.log("[eth_vault_unlock] unknown vault", vaultAddress);
      return "reject";
    }
    let amountWei = 0n;
    try {
      if (input.amountWei != null) amountWei = BigInt(String(input.amountWei));
      else if (input.amount != null) {
        const s = String(input.amount).trim();
        if (s.includes(".")) {
          const [w, f = ""] = s.split(".");
          const frac = (f + "000000000000000000").slice(0, 18);
          amountWei = BigInt(w || "0") * 10n ** 18n + BigInt(frac || "0");
        } else {
          amountWei = BigInt(s) * 10n ** 18n;
        }
      }
    } catch {
      return "reject";
    }
    if (amountWei <= 0n) return "reject";

    const vault = ensureUserVaultShell(owner);
    const outstanding = ethLockedOutstandingWei(vault);
    const claimed = ethShareClaimed18(vault);
    // After unlock, capacity must still cover used wETH claims
    if (outstanding < amountWei) {
      console.log("[eth_vault_unlock] amount > outstanding");
      return "reject";
    }
    const after = outstanding - amountWei;
    if (after < claimed) {
      console.log(
        `[eth_vault_unlock] would leave capacity ${after} < used ${claimed} — burn wETH claims first`,
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "eth_vault_unlock_rejected",
            user: owner,
            vaultAddress,
            amountWei: amountWei.toString(),
            outstanding: outstanding.toString(),
            claimed: claimed.toString(),
            maxFreeableWei: (outstanding > claimed
              ? outstanding - claimed
              : 0n
            ).toString(),
            message: "Burn wETH claims first — Capacity would fall under Used",
          }),
        ),
      );
      return "reject";
    }

    vault.ethLockedBurned = (vault.ethLockedBurned || 0n) + amountWei;
    rec.lockedBurned = (rec.lockedBurned || 0n) + amountWei;
    ethVaultByAddress.set(vaultAddress, rec);
    userVaults.set(owner, vault);

    // Release ticket for cosigner (future ETH vault → main)
    let rel = ethVaultReleaseState.get(vaultAddress);
    if (!rel) {
      rel = { nextNonce: 1, cumulativeBurnedWei: 0n, tickets: [] };
      ethVaultReleaseState.set(vaultAddress, rel);
    }
    const nonce = rel.nextNonce++;
    rel.cumulativeBurnedWei += amountWei;
    const ticket = {
      type: "eth_release_ticket",
      scheme: "eth-release-ticket-v1",
      ticketId: `${vaultAddress.slice(2, 14)}:${nonce}`,
      nonce,
      vaultAddress,
      owner,
      amountWei: amountWei.toString(),
      remainingLockedWei: after.toString(),
      cumulativeBurnedWei: rel.cumulativeBurnedWei.toString(),
      timestamp: Date.now(),
      message: "Freeable ETH collateral ticket — cosigner may release up to amountWei (later)",
    };
    rel.tickets.push(ticket);

    await sendNotice(stringToHex(JSON.stringify({
      type: "eth_vault_unlocked",
      user: owner,
      vaultAddress,
      amountWei: amountWei.toString(),
      amount: formatEther(amountWei),
      ethLockedOutstanding: after.toString(),
      ethCapacity18: after.toString(),
      ethClaimed18: claimed.toString(),
      ethRemaining18: (after > claimed ? after - claimed : 0n).toString(),
    })));
    await sendNotice(stringToHex(JSON.stringify(ticket)));
    console.log(
      `[eth_vault_unlock] ${owner} -${formatEther(amountWei)} ETH capacity vault=${vaultAddress}`,
    );
    return "accept";
  }

  /**
   * mint_weth_claim — mint rollup wETH claim against locked ETH capacity only.
   * Not WART capacity.
   * Optional client fields (after createAssets on Warthog):
   *   assetHash, assetName, assetAmount, assetDecimals, wartAddress, assetTxHash
   * Links the native Warthog ETH asset to this claim amount (value-linked).
   */
  if (input?.type === "mint_weth_claim" || input?.type === "mint_weth") {
    const user = String(sender || "").toLowerCase();
    const vault = ensureUserVaultShell(user);
    let requested = 0n;
    try {
      if (input.amountWei != null) requested = BigInt(String(input.amountWei));
      else {
        const s = String(input.amount || "0").trim();
        if (s.includes(".")) {
          const [w, f = ""] = s.split(".");
          const frac = (f + "000000000000000000").slice(0, 18);
          requested = BigInt(w || "0") * 10n ** 18n + BigInt(frac || "0");
        } else {
          requested = BigInt(s || "0") * 10n ** 18n;
        }
      }
    } catch {
      return "reject";
    }
    if (requested <= 0n) return "reject";

    const capacity = ethBackingCapacity18(vault);
    const already = ethShareClaimed18(vault);
    const remaining = capacity > already ? capacity - already : 0n;
    if (capacity === 0n || remaining === 0n) {
      console.log(
        `[mint_weth_claim] no ETH capacity capacity=${capacity} claimed=${already}`,
      );
      return "reject";
    }
    const mintAmt = requested > remaining ? remaining : requested;
    vault.l1WethClaim = (vault.l1WethClaim || 0n) + mintAmt;
    vault.wethPortable = (vault.wethPortable || 0n) + mintAmt;

    // Optional: native Warthog ETH asset link (client createAssets, amount-linked)
    let ethAssetLink = null;
    const rawHash = input.assetHash != null ? String(input.assetHash).trim() : "";
    const assetHash = rawHash.replace(/^0x/i, "").toLowerCase();
    if (assetHash && /^[0-9a-f]{64}$/.test(assetHash)) {
      ethAssetLink = {
        assetHash,
        assetName: String(input.assetName || "WETH")
          .trim()
          .toUpperCase()
          .slice(0, 5),
        amountWei: mintAmt.toString(),
        amount: formatEther(mintAmt),
        assetAmount:
          input.assetAmount != null ? String(input.assetAmount) : formatEther(mintAmt),
        assetDecimals:
          input.assetDecimals != null ? Number(input.assetDecimals) : 8,
        wartAddress: input.wartAddress
          ? String(input.wartAddress).replace(/^0x/i, "").toLowerCase()
          : null,
        assetTxHash: input.assetTxHash
          ? String(input.assetTxHash).replace(/^0x/i, "").toLowerCase()
          : null,
        timestamp: Date.now(),
      };
      if (!Array.isArray(vault.ethWartAssets)) vault.ethWartAssets = [];
      vault.ethWartAssets.push(ethAssetLink);
      // keep last 32 links
      if (vault.ethWartAssets.length > 32) {
        vault.ethWartAssets = vault.ethWartAssets.slice(-32);
      }
    }

    userVaults.set(user, vault);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "weth_claim_minted",
          token: "wETH",
          user,
          amount: mintAmt.toString(),
          l1WethClaim: vault.l1WethClaim.toString(),
          wethPortable: vault.wethPortable.toString(),
          ethCapacity18: capacity.toString(),
          ethClaimed18: ethShareClaimed18(vault).toString(),
          ethRemaining18: (
            capacity > ethShareClaimed18(vault)
              ? capacity - ethShareClaimed18(vault)
              : 0n
          ).toString(),
          assetHash: ethAssetLink?.assetHash || null,
          assetName: ethAssetLink?.assetName || null,
          assetAmount: ethAssetLink?.assetAmount || null,
          wartAddress: ethAssetLink?.wartAddress || null,
          message: ethAssetLink
            ? `wETH claim + Warthog ETH asset ${ethAssetLink.assetHash.slice(0, 12)}… linked to ${formatEther(mintAmt)} ETH capacity`
            : "wETH claim minted against locked ETH (rollup). Attach assetHash after createAssets for Warthog ETH link.",
        }),
      ),
    );
    console.log(
      `[mint_weth_claim] ${user} +${formatEther(mintAmt)} wETH claim` +
        (ethAssetLink ? ` asset=${ethAssetLink.assetHash.slice(0, 16)}` : ""),
    );
    return "accept";
  }

  /**
   * burn_weth_claim — free ETH capacity Used (does not unlock vault collateral).
   */
  if (input?.type === "burn_weth_claim" || input?.type === "burn_weth") {
    const user = String(sender || "").toLowerCase();
    const vault = ensureUserVaultShell(user);
    let amount = 0n;
    try {
      if (input.amountWei != null) amount = BigInt(String(input.amountWei));
      else {
        const s = String(input.amount || "0").trim();
        if (s.includes(".")) {
          const [w, f = ""] = s.split(".");
          const frac = (f + "000000000000000000").slice(0, 18);
          amount = BigInt(w || "0") * 10n ** 18n + BigInt(frac || "0");
        } else {
          amount = BigInt(s || "0") * 10n ** 18n;
        }
      }
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";

    const claim = vault.l1WethClaim || 0n;
    const portable = vault.wethPortable || 0n;
    // Burn prefers portable cover; allow burn up to claim if portable covers
    const burnable = claim < portable ? claim : portable;
    if (burnable <= 0n) {
      console.log("[burn_weth_claim] nothing burnable");
      return "reject";
    }
    const burnAmt = amount > burnable ? burnable : amount;
    vault.l1WethClaim = claim - burnAmt;
    vault.wethPortable = portable > burnAmt ? portable - burnAmt : 0n;
    userVaults.set(user, vault);

    const capacity = ethBackingCapacity18(vault);
    const claimed = ethShareClaimed18(vault);
    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "weth_claim_burned",
          user,
          amount: burnAmt.toString(),
          l1WethClaim: vault.l1WethClaim.toString(),
          wethPortable: vault.wethPortable.toString(),
          ethCapacity18: capacity.toString(),
          ethClaimed18: claimed.toString(),
          ethRemaining18: (capacity > claimed ? capacity - claimed : 0n).toString(),
          message: "wETH claim burned — ETH capacity Available ↑; release vault lock separately",
        }),
      ),
    );
    console.log(`[burn_weth_claim] ${user} -${formatEther(burnAmt)} wETH claim`);
    return "accept";
  }

  // 3. ETH DEPOSITS ─ using ETH module
  if (sender === ETH.PORTAL_ADDRESS) {
    console.log("ETH PORTAL INPUT RECEIVED - PAYLOAD:", request.payload);

    const parsed = ETH.parseDepositPayload(request.payload);
    if (!parsed) {
      console.log("Invalid amount or depositor — ignoring");
      return "accept";
    }

    const { depositor, amountWei } = parsed;

    const creditMeta = ETH.creditToVault(userVaults, depositor, amountWei);
    console.log(
      `Crediting ${formatEther(amountWei)} ETH → ${creditMeta.creditUser}` +
        (creditMeta.subIndex != null
          ? ` (via eth sub #${creditMeta.subIndex}, depositor ${depositor})`
          : ` (depositor ${depositor})`),
    );

    const noticePayload = ETH.createDepositNotice(depositor, amountWei, creditMeta);
    await sendNotice(stringToHex(JSON.stringify(noticePayload)));

    console.log(
      `*** ETH DEPOSIT CREDITED: ${formatEther(amountWei)} ETH → ${creditMeta.creditUser} ***`,
    );

    return "accept";
  }

  // 4. ERC-20 DEPOSITS (wWART, CTSI, USDC)
  // Cartesi ERC20Portal payload is token(20)||depositor(20)||amount(32)||execData
  // Some stacks prefix a 1-byte portal/version tag (observed 0x01) — detect both.
  if (sender === ERC20Portal) {
    console.log("ERC20 PORTAL INPUT RECEIVED - PAYLOAD:", request.payload);

    let tokenAddress = "", depositor = "", amount = 0n;

    const parseErc20PortalPayload = (payload) => {
      const hex = String(payload || "").replace(/^0x/i, "").toLowerCase();
      const tryAt = (offsetBytes) => {
        const o = offsetBytes * 2;
        if (hex.length < o + 144) return null;
        const token = "0x" + hex.slice(o, o + 40);
        const dep = "0x" + hex.slice(o + 40, o + 80);
        const amt = BigInt("0x" + hex.slice(o + 80, o + 144));
        return { tokenAddress: token, depositor: dep, amount: amt };
      };
      const known = new Set([
        WWART_ADDRESS.toLowerCase(),
        CTSI_ADDRESS.toLowerCase(),
        USDC_ADDRESS.toLowerCase(),
      ].filter((a) => a && a !== "0x0000000000000000000000000000000000000000"));
      const direct = tryAt(0);
      if (direct && known.has(direct.tokenAddress)) return direct;
      const skipped = tryAt(1);
      if (skipped && known.has(skipped.tokenAddress)) {
        console.log("[erc20 portal] parsed with 1-byte prefix skip");
        return skipped;
      }
      // Fall back to direct even if unknown (so we can log/ignore cleanly)
      return direct || skipped;
    };

    try {
      const parsed = parseErc20PortalPayload(request.payload);
      if (!parsed) throw new Error("payload too short");
      tokenAddress = parsed.tokenAddress;
      depositor = parsed.depositor;
      amount = parsed.amount;

      console.log("Parsed token:", tokenAddress);
      console.log("Parsed depositor:", depositor);
      console.log("Parsed amount:", amount.toString());
    } catch (e) {
      console.error("ERC20 payload parsing error:", e);
      return "reject";
    }

    if (amount === 0n) return "accept";

    const vault = ensureUserVaultShell(depositor);

    let type = "unknown";
    let creditMeta = null;
    if (tokenAddress === WWART_ADDRESS.toLowerCase()) {
      // Path-isolated portal inventory. Claims stay used until burn_* —
      // deposit does NOT free Available / Used.
      // Payload: [optional 1-byte prefix] token(20)||depositor(20)||amount(32)||execData
      // Try path hint from execData (both offset layouts).
      const pathHint =
        parsePortalPathHint(request.payload, 72) ||
        parsePortalPathHint(request.payload, 73);
      creditMeta = creditWwartPortal(vault, amount, pathHint);
      type = "wwart_deposited";
      console.log(
        `[wwart portal] ${depositor} +${amount} path=${creditMeta.path} pool+=${creditMeta.poolCredited} personal+=${creditMeta.personalCredited}`,
      );
    } else if (tokenAddress === CTSI_ADDRESS.toLowerCase()) {
      vault.CTSI = (vault.CTSI || 0n) + amount;
      type = "ctsi_deposited";
    } else if (tokenAddress === USDC_ADDRESS.toLowerCase()) {
      vault.usdc = (vault.usdc || 0n) + amount;
      type = "usdc_deposited";
    } else {
      console.log("Unknown token — ignoring", tokenAddress);
      return "accept";
    }

    userVaults.set(depositor, vault);

    await sendNotice(stringToHex(JSON.stringify({
      type,
      user: depositor,
      amount: amount.toString(),
      newBalance: type === "wwart_deposited"
        ? (portalWwart18Of(vault.wWART) + (vault.poolPortalWwart || 0n)).toString()
        : type === "ctsi_deposited" ? vault.CTSI.toString() :
                  vault.usdc.toString(),
      ...(type === "wwart_deposited"
        ? {
            path: creditMeta?.path || "personal",
            poolPortalCredited: (creditMeta?.poolCredited || 0n).toString(),
            personalPortalCredited: (creditMeta?.personalCredited || 0n).toString(),
            l1WwartClaim: (vault.l1WwartClaim || 0n).toString(),
            wWART: portalWwart18Of(vault.wWART).toString(),
            poolPortalWwart: (vault.poolPortalWwart || 0n).toString(),
            poolL1WwartClaim: (vault.poolL1WwartClaim || 0n).toString(),
            message:
              creditMeta?.path === "pool"
                ? "wWART deposited to Path A pool portal — burn with pool_burn_wwart (personal burn cannot use this inventory)"
                : creditMeta?.path === "split"
                  ? "wWART deposited split across Path A pool portal + Path B personal portal"
                  : "wWART deposited to Path B personal portal — burn with burn_wwart (pool burn cannot use this inventory)",
          }
        : {}),
    })));

    return "accept";
  }

  // 5. ETH WITHDRAWAL ─ using ETH module + manual amount parsing
  if (input?.type === "withdraw_eth" && input.amount) {
    const user = sender;

    if (!dAppAddress) {
      console.log("dApp address not relayed yet, cannot withdraw");
      return "reject";
    }

    let amountWei;
    try {
      const parts = input.amount.split('.');
      if (parts.length > 2) throw new Error("Invalid amount format");

      let integerPart   = BigInt(parts[0] || "0");
      let fractionalPart = parts[1]
        ? BigInt(parts[1].padEnd(18, '0').slice(0, 18))
        : 0n;

      amountWei = integerPart * 1000000000000000000n + fractionalPart;

      if (amountWei <= 0n) throw new Error("Amount must be positive");
    } catch (e) {
      console.error("Invalid ETH amount format:", e.message);
      return "reject";
    }

    let vault = userVaults.get(user);
    if (!vault || vault.eth < amountWei) {
      console.log("Insufficient ETH balance for withdrawal");
      return "reject";
    }

    console.log(`Processing withdrawal of ${formatEther(amountWei)} ETH for ${user}`);

    vault.eth -= amountWei;
    userVaults.set(user, vault);

    try {
      const payload = ETH.buildWithdrawPayload(user, amountWei);
      await ETH.emitVoucher(dAppAddress, payload);

      const notice = ETH.createWithdrawNotice(user, amountWei);
      await sendNotice(stringToHex(JSON.stringify(notice)));

      console.log(`*** ETH WITHDRAWAL PROCESSED: ${formatEther(amountWei)} ETH → ${user} ***`);
      return "accept";
    } catch (e) {
      vault.eth += amountWei;
      userVaults.set(user, vault);
      console.error("Voucher emission failed:", e.message);
      return "reject";
    }
  }

  // ERC-20 WITHDRAWALS — real transfer vouchers (not broken wallet.new_voucher)
  // Amount: prefer human decimal string ("13" or "13.5"); bare huge integers treated as wei.
  const parseTokenAmount = (raw, decimals) => {
    const s = String(raw ?? "").trim();
    if (!s) throw new Error("empty amount");
    if (/^\d+$/.test(s) && s.length > 18) return BigInt(s); // already wei-scale
    const parts = s.split(".");
    if (parts.length > 2) throw new Error("bad amount");
    const whole = BigInt(parts[0] || "0");
    const frac = parts[1]
      ? BigInt(parts[1].padEnd(decimals, "0").slice(0, decimals))
      : 0n;
    return whole * 10n ** BigInt(decimals) + frac;
  };

  if (input?.type === "withdraw_wwart") {
    let amt;
    try {
      amt = parseTokenAmount(input.amount, 18);
    } catch (e) {
      console.log("[withdraw_wwart] bad amount", input.amount, e.message);
      return "reject";
    }
    return withdrawErc20FromVault(sender, "wWART", WWART_ADDRESS, amt, "wwart_withdrawn");
  }
  if (input?.type === "withdraw_ctsi") {
    let amt;
    try {
      amt = parseTokenAmount(input.amount, 18);
    } catch {
      return "reject";
    }
    return withdrawErc20FromVault(sender, "CTSI", CTSI_ADDRESS, amt, "ctsi_withdrawn");
  }
  if (input?.type === "withdraw_usdc") {
    let amt;
    try {
      amt = parseTokenAmount(input.amount, 6);
    } catch {
      return "reject";
    }
    return withdrawErc20FromVault(sender, "usdc", USDC_ADDRESS, amt, "usdc_withdrawn");
  }

  /**
   * WLIQ (formerly LIQUID) share mint/burn — 18-dec accounting.
   * Backing capacity prefers Warthog-path wWART in E8 → 18-dec (× 1e10),
   * plus CTSI/usdc (already 18/6 scaled into 18) and eth wei.
   * input.amount: human decimal e.g. "10" (default "1"). Caps to remaining capacity.
   */
  const parseHumanTo18 = (raw, defaultAmt = "1") => {
    const s = String(raw == null || raw === "" ? defaultAmt : raw).trim();
    const parts = s.split(".");
    const whole = BigInt(parts[0] || "0");
    const frac = parts[1] ? BigInt(parts[1].padEnd(18, "0").slice(0, 18)) : 0n;
    return whole * 10n ** 18n + frac;
  };

  /**
   * Share mint capacity (18-dec) from locked Warthog spoofed WART + L1 portal collateral.
   * Does NOT include l1WwartClaim / liquid (those consume capacity).
   * Spoofed outstanding is authoritative for "WART has been locked".
   */
  /** Outstanding locked WART (E8). Prefer append-only histories when present. */
  const spoofedOutstandingE8 = (vault, userKey = null) => {
    if (userKey) {
      const mh = userMintHistories.get(userKey) || userMintHistories.get(String(userKey).replace(/^0x/i, "").toLowerCase()) || [];
      const bh = userBurnHistories.get(userKey) || userBurnHistories.get(String(userKey).replace(/^0x/i, "").toLowerCase()) || [];
      let m = mh.reduce((s, x) => s + BigInt(x.amount || 0), 0n);
      let b = bh.reduce((s, x) => s + BigInt(x.amount || 0), 0n);
      if (m > 0n || b > 0n) return m > b ? m - b : 0n;
    }
    const m = vault.spoofedMinted || 0n;
    const b = vault.spoofedBurned || 0n;
    return m > b ? m - b : 0n;
  };

  /**
   * Mint capacity for WLIQ + wWART claims = locked native WART only.
   * Portal ETH / CTSI / USDC are separate balances (not fungible mint headroom).
   */
  const backingCapacity18 = (vault, userKey = null) => {
    return spoofedOutstandingE8(vault, userKey) * 10n ** 10n;
  };

  /** WLIQ liquid + wWART claims share one WART-backed pool. */
  const shareClaimed18 = (vault) =>
    (vault.liquid || 0n) + (vault.l1WwartClaim || 0n);

  if (input?.type === "mint_liquid" || input?.type === "mint_wliq") {
    const user = sender;
    let vault = userVaults.get(user) || {
      liquid: 0n, wWART: 0n, CTSI: 0n, usdc: 0n, eth: 0n, spoofedMinted: 0n, spoofedBurned: 0n, l1WwartClaim: 0n,
    };

    let requested;
    try {
      requested = parseHumanTo18(input.amount, "1");
    } catch {
      console.log("[mint_wliq] bad amount", input.amount);
      return "reject";
    }
    if (requested <= 0n) {
      console.log("[mint_wliq] non-positive amount");
      return "reject";
    }

    const capacity = backingCapacity18(vault, user);
    const already = shareClaimed18(vault);
    const remaining = capacity > already ? capacity - already : 0n;

    // No free demo mint — need locked WART capacity (not portal ETH/CTSI)
    if (capacity === 0n || remaining === 0n) {
      console.log(
        `[mint_wliq] no capacity — capacity=${capacity} claimed=${already} remaining=${remaining}`,
      );
      return "reject";
    }
    const mintAmt = requested > remaining ? remaining : requested;

    vault.liquid += mintAmt;
    userVaults.set(user, vault);
    await sendNotice(stringToHex(JSON.stringify({
      type: "wliq_minted",
      legacyType: "liquid_minted",
      token: "WLIQ",
      user,
      amount: mintAmt.toString(),
      requested: requested.toString(),
      newBalance: vault.liquid.toString(),
      capacity: capacity.toString(),
      claimed: shareClaimed18(vault).toString(),
      remaining: (capacity > shareClaimed18(vault) ? capacity - shareClaimed18(vault) : 0n).toString(),
      spoofedOutstandingE8: spoofedOutstandingE8(vault, user).toString(),
    })));
    console.log(`[mint_wliq] ${user} +${mintAmt} → balance ${vault.liquid}`);
    return "accept";
  }

  /**
   * sync_wwart_claim — recovery / re-bind capacity after a portable L1 withdraw.
   * Raises l1WwartClaim up to min(requested, capacity − liquid) without
   * increasing wwartPortable (tokens already on MetaMask). Used when older
   * withdraw code incorrectly freed claim on withdraw_wwart.
   */
  if (input?.type === "sync_wwart_claim" || input?.type === "repair_wwart_claim") {
    const user = sender;
    let vault = userVaults.get(user) || {
      liquid: 0n, wWART: 0n, CTSI: 0n, usdc: 0n, eth: 0n, spoofedMinted: 0n, spoofedBurned: 0n, l1WwartClaim: 0n, wwartPortable: 0n,
    };
    let requested;
    try {
      requested = parseHumanTo18(input.amount, "0");
    } catch {
      return "reject";
    }
    if (requested <= 0n) return "reject";
    const capacity = backingCapacity18(vault, user);
    const liquid = vault.liquid || 0n;
    const maxClaim = capacity > liquid ? capacity - liquid : 0n;
    const target = requested > maxClaim ? maxClaim : requested;
    const prev = vault.l1WwartClaim || 0n;
    if (target > prev) {
      vault.l1WwartClaim = target;
      userVaults.set(user, vault);
    }
    const claimed = shareClaimed18(vault);
    await sendNotice(stringToHex(JSON.stringify({
      type: "wwart_claim_synced",
      user,
      previousClaim: prev.toString(),
      l1WwartClaim: (vault.l1WwartClaim || 0n).toString(),
      wwartPortable: (vault.wwartPortable || 0n).toString(),
      capacity: capacity.toString(),
      claimed: claimed.toString(),
      remaining: (capacity > claimed ? capacity - claimed : 0n).toString(),
      message: "Capacity claim re-bound (portable unchanged). Available should drop by the restored claim.",
    })));
    console.log(`[sync_wwart_claim] ${user} claim ${prev} → ${vault.l1WwartClaim}`);
    return "accept";
  }

  /**
   * mint_wwart — same capacity pool as WLIQ.
   * Requires locked Warthog WART (spoofed outstanding > 0).
   * WLIQ claims reduce available capacity.
   * Credits l1WwartClaim + withdrawable wwartPortable (not capacity source).
   */
  if (input?.type === "mint_wwart") {
    const user = sender;
    if (!WWART_ADDRESS || WWART_ADDRESS === "0x0000000000000000000000000000000000000000") {
      console.log("[mint_wwart] WWART_ADDRESS not configured");
      return "reject";
    }
    // Capacity claims are bound to the live L1 token. Legacy mint_wwart inputs
    // (no tokenAddress) or mints for a previous deploy must not re-credit claims
    // when Anvil history is replayed after a zero-supply redeploy.
    const reqToken = String(input.tokenAddress || "").toLowerCase();
    if (!reqToken || reqToken !== WWART_ADDRESS) {
      console.log(
        `[mint_wwart] skip — tokenAddress mismatch or missing (got=${reqToken || "none"} want=${WWART_ADDRESS})`,
      );
      return "accept";
    }
    let vault = userVaults.get(user) || {
      liquid: 0n, wWART: 0n, CTSI: 0n, usdc: 0n, eth: 0n, spoofedMinted: 0n, spoofedBurned: 0n, l1WwartClaim: 0n, wwartPortable: 0n,
    };

    let requested;
    try {
      requested = parseHumanTo18(input.amount, "1");
    } catch {
      console.log("[mint_wwart] bad amount", input.amount);
      return "reject";
    }
    if (requested <= 0n) return "reject";

    const lockedE8 = spoofedOutstandingE8(vault, user);
    if (lockedE8 === 0n) {
      console.log("[mint_wwart] reject — no locked WART (spoofed outstanding 0); lock via sweep first");
      return "reject";
    }

    const capacity = backingCapacity18(vault, user);
    const already = shareClaimed18(vault);
    const remaining = capacity > already ? capacity - already : 0n;
    if (remaining === 0n) {
      console.log(
        `[mint_wwart] capacity fully claimed by WLIQ/wWART — capacity=${capacity} claimed=${already}`,
      );
      return "reject";
    }
    const mintAmt = requested > remaining ? remaining : requested;

    vault.l1WwartClaim = (vault.l1WwartClaim || 0n) + mintAmt;
    // Withdrawable portable balance (18-dec) — does NOT inflate spoofed capacity
    vault.wwartPortable = (vault.wwartPortable || 0n) + mintAmt;
    userVaults.set(user, vault);

    await sendNotice(stringToHex(JSON.stringify({
      type: "wwart_minted",
      token: "wWART",
      tokenAddress: WWART_ADDRESS,
      user,
      amount: mintAmt.toString(),
      requested: requested.toString(),
      newBalance: vault.wWART.toString(),
      l1WwartClaim: vault.l1WwartClaim.toString(),
      wwartPortable: vault.wwartPortable.toString(),
      capacity: capacity.toString(),
      claimed: shareClaimed18(vault).toString(),
      remaining: (capacity > shareClaimed18(vault) ? capacity - shareClaimed18(vault) : 0n).toString(),
      spoofedOutstandingE8: lockedE8.toString(),
      message:
        "wWART claim minted against locked WART capacity (shared with WLIQ). Withdraw via withdraw_wwart / L1 mint path.",
    })));
    console.log(`[mint_wwart] ${user} +${mintAmt} claim; remaining capacity after=${capacity > shareClaimed18(vault) ? capacity - shareClaimed18(vault) : 0n}`);
    return "accept";
  }

  if ((input?.type === "burn_liquid" || input?.type === "burn_wliq") && input.amount) {
    const user = sender;
    let amount;
    try {
      amount = parseHumanTo18(input.amount, "0");
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";
    let vault = userVaults.get(user);
    if (!vault || vault.liquid < amount) {
      console.log("Insufficient WLIQ", vault?.liquid?.toString(), amount.toString());
      return "reject";
    }
    vault.liquid -= amount;
    userVaults.set(user, vault);
    const capacity = backingCapacity18(vault, user);
    const claimed = shareClaimed18(vault);
    await sendNotice(stringToHex(JSON.stringify({
      type: "wliq_burned",
      legacyType: "liquid_burned",
      token: "WLIQ",
      user,
      amount: amount.toString(),
      newBalance: vault.liquid.toString(),
      capacity: capacity.toString(),
      claimed: claimed.toString(),
      remaining: (capacity > claimed ? capacity - claimed : 0n).toString(),
      message: "WLIQ burned — shared mint capacity freed",
    })));
    return "accept";
  }

  /**
   * burn_wwart — free Path B personal capacity by burning personal wWART claims.
   *
   * Open vs filled (must not free capacity while ERC-20 sits only on MetaMask):
   *   openClaim   = wwartPortable          (not yet withdrawn to L1)
   *   filledClaim = l1WwartClaim − portable (already voucher-minted to MetaMask)
   *   burnable    = min(claim, portable + personalPortalInventory)
   *
   * Uses vault.wWART (personal portal) only — NOT poolPortalWwart (Path A).
   * Open claims can be burned immediately (cancel unused claim).
   * Filled claims require depositing L1 wWART back first (personal portal),
   * then burn_wwart debits personal portal 1:1 with claim free.
   * Does not burn native locked WART / spoofed outstanding.
   */
  if ((input?.type === "burn_wwart" || input?.type === "burn_wwart_claim") && input.amount) {
    const user = sender;
    let amount;
    try {
      amount = parseHumanTo18(input.amount, "0");
    } catch {
      console.log("[burn_wwart] bad amount", input.amount);
      return "reject";
    }
    if (amount <= 0n) return "reject";
    let vault = userVaults.get(user);
    if (!vault) {
      console.log("[burn_wwart] no vault");
      return "reject";
    }
    const claim = vault.l1WwartClaim || 0n;
    const portable = vault.wwartPortable || 0n;
    // Path B personal portal only (ignore legacy E8 pollution)
    const portalRaw = vault.wWART || 0n;
    const portal = portalWwart18Of(portalRaw);
    const poolPortal = portalWwart18Of(vault.poolPortalWwart);
    const openClaim = portable < claim ? portable : claim;
    const filledClaim = claim > openClaim ? claim - openClaim : 0n;
    // Cover for capacity free: open portable + Path B returned L1 inventory only
    const coverable = portable + portal;
    const burnable = claim < coverable ? claim : coverable;

    if (claim < amount) {
      console.log(`[burn_wwart] insufficient claim have=${claim} need=${amount}`);
      return "reject";
    }
    if (amount > burnable) {
      console.log(
        `[burn_wwart] reject — filled on L1 without personal return: amount=${amount} burnable=${burnable} open=${openClaim} filled=${filledClaim} personalPortal=${portal} poolPortal=${poolPortal}`,
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "wwart_burn_rejected",
            token: "wWART",
            user,
            amount: amount.toString(),
            l1WwartClaim: claim.toString(),
            wwartPortable: portable.toString(),
            wwartOpenClaim: openClaim.toString(),
            wwartFilledClaim: filledClaim.toString(),
            wwartPortal: portal.toString(),
            poolPortalWwart: poolPortal.toString(),
            wwartBurnable: burnable.toString(),
            message:
              poolPortal > 0n && portal === 0n
                ? "Path A pool portal wWART cannot cover a Path B personal burn. Deposit while only a personal filled claim is open (auto-routes to personal portal), then burn_wwart."
                : "Cannot free filled personal wWART claims while ERC-20 is still on MetaMask. Deposit L1 wWART back to the rollup (personal portal) first, then burn. Open portable can burn without deposit.",
          }),
        ),
      );
      return "reject";
    }

    vault.l1WwartClaim = claim - amount;
    // Debit inventory 1:1 with claim free (portable first, then personal portal).
    let invLeft = amount;
    if (portable > 0n && invLeft > 0n) {
      const d = portable >= invLeft ? invLeft : portable;
      vault.wwartPortable = portable - d;
      invLeft -= d;
    }
    if (portal > 0n && invLeft > 0n) {
      const d = portal >= invLeft ? invLeft : portal;
      vault.wWART = portal - d;
      invLeft -= d;
    }
    if (invLeft > 0n) {
      // Should be unreachable given burnable gate — fail closed
      console.log(`[burn_wwart] invariant fail invLeft=${invLeft}`);
      vault.l1WwartClaim = claim;
      vault.wwartPortable = portable;
      vault.wWART = portalRaw;
      return "reject";
    }
    userVaults.set(user, vault);

    const capacity = backingCapacity18(vault, user);
    const claimed = shareClaimed18(vault);
    await sendNotice(stringToHex(JSON.stringify({
      type: "wwart_burned",
      token: "wWART",
      tokenAddress: WWART_ADDRESS,
      user,
      amount: amount.toString(),
      l1WwartClaim: vault.l1WwartClaim.toString(),
      wwartPortable: (vault.wwartPortable || 0n).toString(),
      wWART: (vault.wWART || 0n).toString(),
      capacity: capacity.toString(),
      claimed: claimed.toString(),
      remaining: (capacity > claimed ? capacity - claimed : 0n).toString(),
      message:
        "wWART claim burned against open portable and/or returned portal inventory — Used capacity freed. Filled MetaMask wWART must be deposited before it can free capacity.",
    })));
    console.log(`[burn_wwart] ${user} -${amount} claim remaining=${vault.l1WwartClaim}`);
    return "accept";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PATH A — FUNGIBLE POOL (does not touch personal cosigner vaults / spoofed)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * pool_deposit — legacy host-attested deposit (lab).
   * Prefer wart_deposit_claim (SPV). Set POOL_REQUIRE_SPV=1 to reject this path.
   */
  if (input?.type === "pool_deposit") {
    if (POOL_REQUIRE_SPV) {
      console.log("[pool_deposit] reject: POOL_REQUIRE_SPV=1 — use wart_deposit_claim");
      try {
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "pool_deposit_rejected",
              reason: "POOL_REQUIRE_SPV=1 — submit wart_deposit_claim",
              message: "Legacy pool_deposit disabled; SPV path required",
            }),
          ),
        );
      } catch {
        /* ignore */
      }
      return "reject";
    }
    const owner = String(input.owner || sender).toLowerCase();
    const proof = input.depositProof || input.proof || input.sweepProof;
    const tx = normalizeWarthogTx(proof);

    /** Emit reject notice so FE can fail fast instead of hanging on waitForNotice. */
    const rejectDeposit = async (reason, extra = {}) => {
      console.log(`[pool_deposit] reject: ${reason}`, extra);
      try {
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "pool_deposit_rejected",
              scheme: "wart-pool-deposit-v0",
              owner,
              reason,
              txHash: extra.txHash || tx?.txHash || null,
              toAddress: extra.toAddress || tx?.toAddress || null,
              amountE8:
                extra.amountE8 != null
                  ? String(extra.amountE8)
                  : tx?.amountE8 != null
                    ? String(tx.amountE8)
                    : null,
              poolAddress: fungiblePool.poolAddress,
              message: reason,
            }),
          ),
        );
      } catch (e) {
        console.error("[pool_deposit] reject notice failed:", e?.message || e);
      }
      return "reject";
    };

    if (!tx || !tx.toAddress || !(Number(tx.amountE8) > 0)) {
      return await rejectDeposit("invalid deposit proof (missing to/amount)");
    }
    const toNorm = String(tx.toAddress).replace(/^0x/i, "").toLowerCase();
    if (toNorm !== fungiblePool.poolAddress) {
      return await rejectDeposit(
        `to address is not the fungible pool (got ${toNorm.slice(0, 12)}…)`,
        { toAddress: toNorm },
      );
    }
    const txHash = String(tx.txHash || "").toLowerCase();
    if (txHash && fungiblePool.usedDepositTxs.has(txHash)) {
      return await rejectDeposit("duplicate Warthog deposit tx", { txHash });
    }
    const amtE8 = BigInt(String(tx.amountE8));
    if (amtE8 <= 0n) {
      return await rejectDeposit("amount must be > 0", { amountE8: "0" });
    }

    if (txHash) fungiblePool.usedDepositTxs.add(txHash);
    fungiblePool.lockedE8 += amtE8;
    const pu = ensurePoolUser(owner);
    pu.depositedE8 += amtE8;
    ensureUserVaultShell(owner);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "pool_deposit",
          scheme: "wart-pool-deposit-v0",
          ...poolSnapshot(owner),
          owner,
          amountE8: amtE8.toString(),
          fromAddress: tx.fromAddress || null,
          txHash: txHash || null,
          source: "pool",
          message:
            "Real WART deposited to fungible pool — mint headroom increased (Path A)",
        }),
      ),
    );
    console.log(
      `[pool_deposit] ${owner} +${amtE8} E8 locked=${fungiblePool.lockedE8}`,
    );
    return "accept";
  }

  /**
   * pool_mint_wwart — mint claim against *pool* capacity only.
   * Credits poolL1WwartClaim + poolWwartPortable (not personal l1WwartClaim).
   */
  if (input?.type === "pool_mint_wwart") {
    const user = sender;
    if (!WWART_ADDRESS || WWART_ADDRESS === "0x0000000000000000000000000000000000000000") {
      console.log("[pool_mint_wwart] WWART_ADDRESS not configured");
      return "reject";
    }
    const reqToken = String(input.tokenAddress || "").toLowerCase();
    if (!reqToken || reqToken !== WWART_ADDRESS) {
      console.log(
        `[pool_mint_wwart] token mismatch got=${reqToken || "none"} want=${WWART_ADDRESS}`,
      );
      return "accept";
    }
    let requested;
    try {
      requested = parseHumanTo18(input.amount, "1");
    } catch {
      return "reject";
    }
    if (requested <= 0n) return "reject";
    const available = poolAvailable18();
    if (available <= 0n) {
      console.log("[pool_mint_wwart] no pool capacity — deposit WART to pool first");
      return "reject";
    }
    const mintAmt = requested > available ? available : requested;
    const pu = ensurePoolUser(user);
    const vault = ensureUserVaultShell(user);

    fungiblePool.claimed18 += mintAmt;
    pu.claim18 += mintAmt;
    pu.portable18 += mintAmt;
    vault.poolL1WwartClaim = (vault.poolL1WwartClaim || 0n) + mintAmt;
    vault.poolWwartPortable = (vault.poolWwartPortable || 0n) + mintAmt;
    userVaults.set(user, vault);

    // Keep `user` as address string (do not spread poolSnapshot over it — FE matches owner).
    const snap = poolSnapshot(user);
    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "pool_wwart_minted",
          token: "wWART",
          tokenAddress: WWART_ADDRESS,
          user,
          owner: user,
          amount: mintAmt.toString(),
          amountE8: (mintAmt / 10n ** 10n).toString(),
          source: "pool",
          poolL1WwartClaim: vault.poolL1WwartClaim.toString(),
          poolWwartPortable: vault.poolWwartPortable.toString(),
          pool: snap,
          lockedE8: snap.lockedE8,
          claimed18: snap.claimed18,
          available18: snap.available18,
          message:
            "Path A pool claim minted. Withdraw via pool_withdraw_wwart (L1 mint voucher). Not personal vault capacity.",
        }),
      ),
    );
    console.log(`[pool_mint_wwart] ${user} +${mintAmt} pool claim`);
    return "accept";
  }

  /**
   * pool_withdraw_wwart — L1 mint voucher for pool portable claims.
   * Capacity stays used until pool_burn_wwart.
   */
  if (input?.type === "pool_withdraw_wwart") {
    const user = sender;
    let amount;
    try {
      amount = parseHumanTo18(input.amount, "0");
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";
    if (!WWART_ADDRESS || WWART_ADDRESS === "0x0000000000000000000000000000000000000000") {
      return "reject";
    }
    const vault = ensureUserVaultShell(user);
    const portable = vault.poolWwartPortable || 0n;
    if (portable < amount) {
      console.log(
        `[pool_withdraw_wwart] insufficient portable have=${portable} need=${amount}`,
      );
      return "reject";
    }
    vault.poolWwartPortable = portable - amount;
    // claim stays (filled on L1)
    userVaults.set(user, vault);
    const pu = ensurePoolUser(user);
    if (pu.portable18 >= amount) pu.portable18 -= amount;
    else pu.portable18 = 0n;

    try {
      await ERC20.emitVoucher(
        WWART_ADDRESS,
        ERC20.buildMintPayload(user, amount),
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_wwart_withdrawn",
            user,
            amount: amount.toString(),
            tokenAddress: WWART_ADDRESS,
            source: "pool",
            poolL1WwartClaim: (vault.poolL1WwartClaim || 0n).toString(),
            poolWwartPortable: (vault.poolWwartPortable || 0n).toString(),
            message:
              "L1 mint voucher for pool claim — execute voucher for MetaMask wWART. Capacity still used until burn.",
          }),
        ),
      );
      console.log(`[pool_withdraw_wwart] ${user} mint voucher ${amount}`);
      return "accept";
    } catch (e) {
      vault.poolWwartPortable = portable;
      userVaults.set(user, vault);
      pu.portable18 += amount;
      console.error("[pool_withdraw_wwart] voucher failed", e.message);
      return "reject";
    }
  }

  /**
   * pool_burn_wwart — free pool capacity.
   * A-α: minter path — burn open portable and/or own filled claim (portal inventory).
   * A-β: holder path — any L1 owner with pool-portal wWART may burn against *global*
   *       claimed capacity (true fungible peg); auto-unlock pays redeemer (FIFO deposits).
   * Does NOT consume Path B personal portal (vault.wWART) — paths stay isolated.
   */
  if (input?.type === "pool_burn_wwart") {
    const user = sender;
    let amount;
    try {
      amount = parseHumanTo18(input.amount, "0");
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";
    const vault = ensureUserVaultShell(user);
    const claim = vault.poolL1WwartClaim || 0n;
    const portable = vault.poolWwartPortable || 0n;
    const portal = portalWwart18Of(vault.poolPortalWwart);
    const personalPortal = portalWwart18Of(vault.wWART);
    const globalClaim = fungiblePool.claimed18;
    const autoUnlock = input.autoUnlock !== false && input.autoUnlock !== 0;
    const toAddress = input.toAddress || null;

    // ── A-β holder burn: no personal claim required; portal + global claimed ──
    const isHolderBurn =
      claim < amount && portal >= amount && globalClaim >= amount;

    if (isHolderBurn) {
      vault.poolPortalWwart = portal - amount;
      userVaults.set(user, vault);
      fungiblePool.claimed18 = globalClaim - amount;
      const claimDebits = debitFilledClaimsFifo(amount, user);

      let unlockTicket = null;
      if (autoUnlock) {
        const burnE8 = amount / 10n ** 10n;
        if (burnE8 > 0n) {
          try {
            unlockTicket = await issuePoolReleaseTicket({
              user,
              amtE8: burnE8,
              amount18: amount,
              toAddress,
              reason: "holder-burn-unlock",
            });
            console.log(
              `[pool_burn_wwart] A-β holder unlock ${user} e8=${burnE8} ticket=${unlockTicket.ticketId}`,
            );
          } catch (e) {
            console.error(
              "[pool_burn_wwart] A-β auto-unlock failed:",
              e?.message || e,
            );
          }
        }
      }

      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_wwart_burned",
            token: "wWART",
            tokenAddress: WWART_ADDRESS,
            user,
            amount: amount.toString(),
            source: "pool",
            phase: "A-beta",
            reason: "holder-burn",
            claimDebits,
            poolL1WwartClaim: (vault.poolL1WwartClaim || 0n).toString(),
            poolWwartPortable: (vault.poolWwartPortable || 0n).toString(),
            poolPortalWwart: (vault.poolPortalWwart || 0n).toString(),
            unlockTicketId: unlockTicket?.ticketId || null,
            unlockAmountE8: unlockTicket?.amountE8 || null,
            toAddress: unlockTicket?.toAddress || toAddress || null,
            ...poolSnapshot(user),
            message: unlockTicket
              ? "A-β holder burn — release ticket issued; hot wallet pays WART to redeem-to"
              : "A-β holder burn — pool Available ↑. Set redeem-to and re-burn with autoUnlock or use Redeem.",
          }),
        ),
      );
      console.log(`[pool_burn_wwart] A-β holder ${user} -${amount}`);
      return "accept";
    }

    // ── A-α minter / same-owner burn ──
    const coverable = portable + portal;
    const burnable = claim < coverable ? claim : coverable;
    if (claim < amount) {
      console.log(
        `[pool_burn_wwart] insufficient claim ${claim} < ${amount} (holder needs portal+global claimed)`,
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_wwart_burn_rejected",
            user,
            amount: amount.toString(),
            claim: claim.toString(),
            poolPortalWwart: portal.toString(),
            globalClaimed18: globalClaim.toString(),
            message:
              portal < amount
                ? "Deposit L1 wWART via portal (Path A) before burning. Holders: any open pool claim on the peg backs your burn."
                : "No open pool claims to redeem against (global claimed insufficient).",
          }),
        ),
      );
      return "reject";
    }
    if (amount > burnable) {
      console.log(
        `[pool_burn_wwart] need pool portal deposit burnable=${burnable} poolPortal=${portal} personalPortal=${personalPortal} (personal cannot cover pool)`,
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_wwart_burn_rejected",
            user,
            amount: amount.toString(),
            burnable: burnable.toString(),
            poolPortalWwart: portal.toString(),
            personalPortalWwart: personalPortal.toString(),
            message:
              personalPortal > 0n && portal === 0n
                ? "Path B personal portal wWART cannot cover a Path A pool burn. Deposit again while a pool filled claim is open (auto-routes to pool portal), or burn open portable only."
                : "Deposit L1 wWART back via portal for Path A (pool portal) before burning filled pool claims (or burn open portable only).",
          }),
        ),
      );
      return "reject";
    }

    vault.poolL1WwartClaim = claim - amount;
    let invLeft = amount;
    if (portable > 0n && invLeft > 0n) {
      const d = portable >= invLeft ? invLeft : portable;
      vault.poolWwartPortable = portable - d;
      invLeft -= d;
    }
    if (portal > 0n && invLeft > 0n) {
      const d = portal >= invLeft ? invLeft : portal;
      vault.poolPortalWwart = portal - d;
      invLeft -= d;
    }
    if (invLeft > 0n) {
      vault.poolL1WwartClaim = claim;
      vault.poolWwartPortable = portable;
      vault.poolPortalWwart = portal;
      return "reject";
    }
    userVaults.set(user, vault);

    const g = fungiblePool.claimed18;
    fungiblePool.claimed18 = g > amount ? g - amount : 0n;
    const pu = ensurePoolUser(user);
    pu.claim18 = pu.claim18 > amount ? pu.claim18 - amount : 0n;
    if (pu.portable18 > (vault.poolWwartPortable || 0n)) {
      pu.portable18 = vault.poolWwartPortable || 0n;
    }

    // Auto-unlock free headroom created by this burn (filled reverse path).
    // opt-out: autoUnlock: false
    let unlockTicket = null;
    if (autoUnlock) {
      const burnE8 = amount / 10n ** 10n;
      const freeable = userFreeableE8(user);
      const unlockE8 = burnE8 < freeable ? burnE8 : freeable;
      if (unlockE8 > 0n) {
        try {
          unlockTicket = await issuePoolReleaseTicket({
            user,
            amtE8: unlockE8,
            amount18: unlockE8 * 10n ** 10n,
            toAddress,
            reason: "burn-auto-unlock",
          });
          console.log(
            `[pool_burn_wwart] auto-unlock ${user} e8=${unlockE8} ticket=${unlockTicket.ticketId}`,
          );
        } catch (e) {
          console.error(
            "[pool_burn_wwart] auto-unlock failed:",
            e?.message || e,
          );
        }
      }
    }

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "pool_wwart_burned",
          token: "wWART",
          tokenAddress: WWART_ADDRESS,
          user,
          amount: amount.toString(),
          source: "pool",
          phase: "A-alpha",
          reason: "owner-burn",
          poolL1WwartClaim: vault.poolL1WwartClaim.toString(),
          poolWwartPortable: (vault.poolWwartPortable || 0n).toString(),
          poolPortalWwart: (vault.poolPortalWwart || 0n).toString(),
          unlockTicketId: unlockTicket?.ticketId || null,
          unlockAmountE8: unlockTicket?.amountE8 || null,
          toAddress: unlockTicket?.toAddress || toAddress || null,
          ...poolSnapshot(user),
          message: unlockTicket
            ? "Pool claim burned + free deposit unlocked — execute payout for release ticket"
            : "Pool claim burned — pool Available ↑. Redeem freeable deposit to unlock native WART.",
        }),
      ),
    );
    console.log(`[pool_burn_wwart] ${user} -${amount}`);
    return "accept";
  }

  /**
   * pool_unlock — pay out free headroom deposit (no open claim required).
   * Use after burn of filled claims when locked deposit remains, or anytime
   * user.depositedE8 and global freeable allow.
   */
  if (input?.type === "pool_unlock") {
    const user = sender;
    let amount;
    try {
      // Prefer explicit amountE8; else human WART → 18-dec → E8
      if (input.amountE8 != null && String(input.amountE8).trim() !== "") {
        amount = BigInt(String(input.amountE8)) * 10n ** 10n;
      } else {
        amount = parseHumanTo18(input.amount, "0");
      }
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";
    const amtE8 = amount / 10n ** 10n;
    if (amtE8 <= 0n) {
      console.log("[pool_unlock] amount too small for E8");
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_unlock_rejected",
            user,
            reason: "amount too small",
            message: "Unlock amount must be ≥ 1e-8 WART",
          }),
        ),
      );
      return "reject";
    }
    const freeable = userFreeableE8(user);
    if (freeable < amtE8) {
      console.log(
        `[pool_unlock] insufficient freeable freeable=${freeable} need=${amtE8} claim still open?`,
      );
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_unlock_rejected",
            user,
            reason: "insufficient freeable",
            freeableE8: freeable.toString(),
            requestedE8: amtE8.toString(),
            ...poolSnapshot(user),
            message:
              freeable === 0n
                ? "No freeable deposit — burn open/filled claims first (deposit MetaMask wWART if filled), or deposit WART with no open claim."
                : `Only ${freeable} E8 freeable (burn more claims or reduce amount).`,
          }),
        ),
      );
      return "reject";
    }
    let ticket;
    try {
      ticket = await issuePoolReleaseTicket({
        user,
        amtE8,
        amount18: amount,
        toAddress: input.toAddress || null,
        reason: "free-deposit-unlock",
      });
    } catch (e) {
      console.error("[pool_unlock] failed:", e?.message || e);
      return "reject";
    }
    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "pool_unlocked",
          user,
          ticketId: ticket.ticketId,
          amountE8: amtE8.toString(),
          amount18: amount.toString(),
          toAddress: ticket.toAddress,
          source: "pool",
          reason: "free-deposit-unlock",
          ...poolSnapshot(user),
        }),
      ),
    );
    console.log(`[pool_unlock] ${user} ticket ${ticket.ticketId} amtE8=${amtE8}`);
    return "accept";
  }

  /**
   * pool_redeem — A-α:
   *  (1) Open portable claim → burn claim + unlock locked WART + ticket
   *  (2) Else free-deposit unlock (post-burn stranded deposit) → ticket only
   * Does not use cosigner. Actual Warthog transfer is ops/hot-wallet off-chain.
   */
  if (input?.type === "pool_redeem") {
    const user = sender;
    let amount;
    try {
      amount = parseHumanTo18(input.amount, "0");
    } catch {
      return "reject";
    }
    if (amount <= 0n) return "reject";
    // 18-dec → E8 (truncate)
    const amtE8 = amount / 10n ** 10n;
    if (amtE8 <= 0n) {
      console.log("[pool_redeem] amount too small for E8");
      return "reject";
    }
    const vault = ensureUserVaultShell(user);
    const claim = vault.poolL1WwartClaim || 0n;
    const portable = vault.poolWwartPortable || 0n;
    const toAddress =
      String(input.toAddress || "").replace(/^0x/i, "").toLowerCase() || null;

    // Path 1: open portable redeem (mint claim still on rollup)
    if (portable >= amount && claim >= amount) {
      if (fungiblePool.lockedE8 < amtE8) {
        console.log("[pool_redeem] pool locked insufficient");
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "pool_redeem_rejected",
              user,
              reason: "insufficient locked",
              message: "Pool locked WART insufficient for redeem",
            }),
          ),
        );
        return "reject";
      }

      vault.poolL1WwartClaim = claim - amount;
      vault.poolWwartPortable = portable - amount;
      userVaults.set(user, vault);

      fungiblePool.claimed18 =
        fungiblePool.claimed18 > amount ? fungiblePool.claimed18 - amount : 0n;
      const pu = ensurePoolUser(user);
      pu.claim18 = pu.claim18 > amount ? pu.claim18 - amount : 0n;
      pu.portable18 = pu.portable18 > amount ? pu.portable18 - amount : 0n;

      let ticket;
      try {
        ticket = await issuePoolReleaseTicket({
          user,
          amtE8,
          amount18: amount,
          toAddress,
          reason: "portable-redeem",
        });
      } catch (e) {
        // roll back claim burn if ticket fails
        vault.poolL1WwartClaim = claim;
        vault.poolWwartPortable = portable;
        userVaults.set(user, vault);
        fungiblePool.claimed18 += amount;
        pu.claim18 += amount;
        pu.portable18 += amount;
        console.error("[pool_redeem] ticket failed:", e?.message || e);
        return "reject";
      }

      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_redeemed",
            user,
            ticketId: ticket.ticketId,
            amountE8: amtE8.toString(),
            amount18: amount.toString(),
            toAddress,
            source: "pool",
            reason: "portable-redeem",
            ...poolSnapshot(user),
          }),
        ),
      );
      console.log(
        `[pool_redeem] portable ${user} ticket ${ticket.ticketId} amtE8=${amtE8}`,
      );
      return "accept";
    }

    // Path 2: free-deposit unlock (claim already burned / no portable)
    const freeable = userFreeableE8(user);
    if (freeable >= amtE8) {
      let ticket;
      try {
        ticket = await issuePoolReleaseTicket({
          user,
          amtE8,
          amount18: amount,
          toAddress,
          reason: "free-deposit-unlock",
        });
      } catch (e) {
        console.error("[pool_redeem] unlock failed:", e?.message || e);
        return "reject";
      }
      await sendNotice(
        stringToHex(
          JSON.stringify({
            type: "pool_redeemed",
            user,
            ticketId: ticket.ticketId,
            amountE8: amtE8.toString(),
            amount18: amount.toString(),
            toAddress,
            source: "pool",
            reason: "free-deposit-unlock",
            ...poolSnapshot(user),
            message:
              "Redeemed freeable deposit (no open portable claim) — hot wallet payout",
          }),
        ),
      );
      console.log(
        `[pool_redeem] free-unlock ${user} ticket ${ticket.ticketId} amtE8=${amtE8}`,
      );
      return "accept";
    }

    console.log(
      `[pool_redeem] reject portable=${portable} claim=${claim} freeable=${freeable} amt=${amount}`,
    );
    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "pool_redeem_rejected",
          user,
          reason: "no portable and insufficient freeable",
          portable: portable.toString(),
          claim: claim.toString(),
          freeableE8: freeable.toString(),
          requestedE8: amtE8.toString(),
          ...poolSnapshot(user),
          message:
            freeable === 0n && claim > 0n
              ? "Filled claim still open — deposit MetaMask wWART via portal, then Burn claim (auto-unlocks) or burn then Redeem freeable."
              : freeable === 0n
                ? "Nothing to redeem — no open portable claim and no freeable deposit."
                : `Only ${Number(freeable) / 1e8} WART freeable — reduce amount or burn more claims first.`,
        }),
      ),
    );
    return "reject";
  }

  // PERSONAL VAULT — register spendable Warthog vault (client-derived address preferred)
  if (input?.type === "create_vault") {
    console.log("Processing create_vault input:", input);

    const { subAddress, index: subIndex, owner, assetHash, assetName, vaultAddress: clientVault } = input;
    if (!subAddress || subIndex === undefined || subIndex === null || !owner) {
      console.log("[create_vault] Missing fields — rejecting");
      return "reject";
    }

    const ownerLower = owner.toLowerCase();
    let vaultAddress;
    try {
      vaultAddress = await resolveVaultAddress({
        vaultAddress: clientVault,
        subAddress,
        subIndex,
      });
    } catch (e) {
      console.error("[create_vault] vault resolve failed:", e);
      return "reject";
    }

    personalVaults.set(ownerLower, {
      owner: ownerLower,
      subAddress,
      subIndex,
      vaultAddress,
      assetHash: assetHash || null,
      assetName: assetName || null,
      fundedE8: 0n,
      locked: false,
      scheme: clientVault ? "client-secret-v1" : "legacy-commitment",
    });

    await sendNotice(stringToHex(JSON.stringify({
      type: "vault_created",
      subAddress,
      vaultAddress,
      assetHash: assetHash || null,
      assetName: assetName || null,
      owner: ownerLower,
      scheme: clientVault ? "client-secret-v1" : "legacy-commitment",
      timestamp: Date.now(),
      message: clientVault
        ? "Spendable Warthog vault registered (client-derived). Fund via sub → vault sweep; locked while spoofed wWART outstanding."
        : "Legacy commitment vault registered (not spendable without client key scheme). Prefer client vaultAddress.",
    })));

    console.log(`[create_vault] Registered vault ${vaultAddress} for ${ownerLower}`);
    return "accept";
  }

  // SUBWALLET / LOCK / UNLOCK LOGIC ─ unchanged
  if (input?.type === "sub_lock") {
    console.log("Processing sub_lock input:", input);

    const { subAddress, proof, index: subIndex, recipient: owner } = input;

    // subIndex may be 0 — do not use truthy check
    if (!subAddress || !proof || subIndex === undefined || subIndex === null || !owner) {
      console.log("[sub_lock] Missing fields — rejecting");
      return "reject";
    }

    const ownerLower = owner.toLowerCase();

    const tx = normalizeWarthogTx(proof);
    // Deposit origin does NOT matter: main→sub, peer→sub, or any inbound to sub.
    // Only require: proof is a positive WART transfer TO this sub address.
    const toNormSub = String(tx?.toAddress || "")
      .replace(/^0x/i, "")
      .toLowerCase();
    const subNormLock = String(subAddress || "")
      .replace(/^0x/i, "")
      .toLowerCase();
    if (!tx || toNormSub !== subNormLock || !(Number(tx.amountE8) > 0)) {
      console.log(
        "[sub_lock] Invalid proof — rejecting",
        { to: toNormSub, sub: subNormLock, amountE8: tx?.amountE8 },
      );
      return "reject";
    }

    const mintedAmount = BigInt(tx.amountE8);

    // Prefer client-derived spendable vault (mnemonic+secret+index offline).
    // Fallback: Rust legacy commitment on the machine.
    let vaultAddress;
    try {
      vaultAddress = await resolveVaultAddress({
        vaultAddress: input.vaultAddress,
        subAddress,
        subIndex,
      });
      console.log(
        `Vault address resolved: ${vaultAddress} (${input.vaultAddress ? "client-secret-v1" : "legacy-commitment"})`,
      );
    } catch (e) {
      console.error("[sub_lock] vault resolve failed:", e);
      return "reject";
    }

    pendingLocks.set(subAddress, {
      owner: ownerLower,
      proof,
      vaultAddress,
      mintedAmount,
      depositTxHash: tx.txHash,
      scheme: input.vaultAddress ? "client-secret-v1" : "legacy-commitment",
    });

    await sendNotice(stringToHex(JSON.stringify({
      type: "subwallet_pending",
      subAddress,
      vaultAddress,
      mintedE8: mintedAmount.toString(),
      scheme: input.vaultAddress ? "client-secret-v1" : "legacy-commitment",
      timestamp: Date.now(),
      message:
        "Deposit locked path: sweep WART sub → vault, then sweep_lock mints spoofed wWART. Vault stays locked until burn/unlock.",
    })));

    console.log(`[sub_lock] PENDING: ${subAddress} initiated for ${ownerLower}, vault ${vaultAddress}`);

    return "accept";
  }

  if (input?.type === "sub_unlock") {
    console.log("Processing sub_unlock input:", input);

    // burnAmt: integer E8 string (preferred) or full unlock if omitted.
    // Partial burns keep vault locked until outstanding minted hits 0.
    const { subAddress, proof, burnAmt } = input;

    if (!subAddress) {
      console.log("[sub_unlock] Missing subAddress — rejecting");
      return "reject";
    }

    const subNorm = String(subAddress).replace(/^0x/i, "").toLowerCase();
    const subLock = subLocks.get(subNorm) || subLocks.get(subAddress);
    if (!subLock || !subLock.locked) {
      console.log("[sub_unlock] Subwallet not locked — rejecting");
      return "reject";
    }

    // Only L1 owner who locked may unlock
    if (subLock.owner && subLock.owner.toLowerCase() !== sender) {
      console.log("[sub_unlock] Sender is not lock owner — rejecting");
      return "reject";
    }

    /** Parse burn amount: bare E8 integer, or decimal WART string. */
    const parseBurnE8 = (raw, fullMinted) => {
      if (raw == null || raw === "") return BigInt(fullMinted || 0n);
      const s = String(raw).trim();
      if (/^\d+$/.test(s)) return BigInt(s); // E8 integer
      if (/^\d+\.\d+$/.test(s) || /^\d+\.$/.test(s) || /^\.\d+$/.test(s)) {
        const [w, f = ""] = s.split(".");
        const frac = (f + "00000000").slice(0, 8);
        return BigInt(w || "0") * 100000000n + BigInt(frac || "0");
      }
      return BigInt(s);
    };

    const outstanding = BigInt(subLock.minted || 0n);
    let burnedAmount;
    try {
      burnedAmount = parseBurnE8(burnAmt, outstanding);
    } catch {
      console.log("[sub_unlock] Invalid burnAmt — rejecting", burnAmt);
      return "reject";
    }

    if (burnedAmount <= 0n) {
      console.log("[sub_unlock] Invalid burn amount — rejecting");
      return "reject";
    }

    if (burnedAmount > outstanding) {
      console.log(
        `[sub_unlock] Burn ${burnedAmount} exceeds outstanding ${outstanding} — rejecting`,
      );
      return "reject";
    }

    // Solvency: capacity must stay ≥ Used (WLIQ + wWART claims) after release.
    // Otherwise release would leave claims unbacked. User must burn claims first.
    const ownerForCap = (subLock.owner || sender || "").toLowerCase();
    const ownerVaultForCap = ownerForCap
      ? userVaults.get(ownerForCap) || userVaults.get(ownerForCap.replace(/^0x/i, ""))
      : null;
    if (ownerVaultForCap) {
      const used18 = shareClaimed18(ownerVaultForCap);
      const capNow18 = backingCapacity18(ownerVaultForCap, ownerForCap);
      // Releasing burnedAmount E8 removes that much WART-backed capacity (E8 → 18-dec).
      const capDrop18 = burnedAmount * 10n ** 10n;
      const capAfter18 = capNow18 > capDrop18 ? capNow18 - capDrop18 : 0n;
      if (used18 > 0n && capAfter18 < used18) {
        const maxFreeableE8 =
          capNow18 > used18 ? (capNow18 - used18) / 10n ** 10n : 0n;
        console.log(
          `[sub_unlock] REJECT capacity would fall under Used — ` +
            `capNow=${capNow18} used=${used18} after=${capAfter18} ` +
            `requestedE8=${burnedAmount} maxFreeableE8=${maxFreeableE8}`,
        );
        await sendNotice(
          stringToHex(
            JSON.stringify({
              type: "sub_unlock_rejected",
              reason: "capacity_below_used",
              subAddress: subNorm,
              owner: ownerForCap,
              burnedE8Requested: burnedAmount.toString(),
              capacity18: capNow18.toString(),
              used18: used18.toString(),
              capacityAfter18: capAfter18.toString(),
              maxFreeableE8: maxFreeableE8.toString(),
              message:
                "Release blocked: would leave capacity under Used. Burn wWART/WLIQ claims first, or release at most maxFreeableE8.",
            }),
          ),
        );
        return "reject";
      }
    }

    // Optional proof validation when provided (future: require Warthog burn proof)
    if (proof) {
      const tx = normalizeWarthogTx(proof);
      if (tx && tx.amountE8 != null && BigInt(tx.amountE8) < burnedAmount) {
        console.log("[sub_unlock] Proof amount below burnAmt — rejecting");
        return "reject";
      }
    }

    // Partial burn: unlock only when full outstanding amount returned
    const remainingMinted = outstanding - burnedAmount;
    subLock.minted = remainingMinted;
    if (remainingMinted === 0n) {
      subLock.locked = false;
    }
    subLocks.set(subNorm, subLock);
    subLocks.set(subAddress, subLock);

    const vaultAddress = subLock.vaultAddress
      ? String(subLock.vaultAddress).replace(/^0x/i, "").toLowerCase()
      : null;
    // outstanding = spoofedMinted − spoofedBurned (append-only counters).
    // Only INCREMENT burned — never also decrement minted (that double-counted
    // and made capacity show 76 after releasing 2 from 80).
    let vault = userVaults.get(vaultAddress);
    if (vault) {
      vault.spoofedBurned = (vault.spoofedBurned || 0n) + burnedAmount;
      // Collateral is spoofedMinted (E8) only — do not debit portal wWART (18-dec)
      userVaults.set(vaultAddress, vault);
    }

    // Mirror burn on L1 owner vault (WalletIsland inspect / mint capacity)
    const ownerLower = (subLock.owner || sender || "").toLowerCase();
    if (ownerLower) {
      let ownerVault = userVaults.get(ownerLower);
      if (ownerVault) {
        ownerVault.spoofedBurned = (ownerVault.spoofedBurned || 0n) + burnedAmount;
        userVaults.set(ownerLower, ownerVault);
      }
      const personal = personalVaults.get(ownerLower);
      if (personal) {
        if (personal.fundedE8 >= burnedAmount) personal.fundedE8 -= burnedAmount;
        else personal.fundedE8 = 0n;
        if (remainingMinted === 0n) personal.locked = false;
        personalVaults.set(ownerLower, personal);
      }
    }

    const history = userBurnHistories.get(vaultAddress || ownerLower) || [];
    history.push({
      amount: burnedAmount,
      subAddress,
      timestamp: Date.now(),
    });
    userBurnHistories.set(vaultAddress || ownerLower, history);

    const ownerHistory = userBurnHistories.get(ownerLower) || [];
    if (ownerLower && vaultAddress !== ownerLower) {
      ownerHistory.push({
        amount: burnedAmount,
        subAddress,
        timestamp: Date.now(),
      });
      userBurnHistories.set(ownerLower, ownerHistory);
    }

    // Burn/return of spoofed wWART → dApp releases vault collateral policy when fully burned.
    // Native WART still sits at vaultAddress until owner spends with client-derived vault key.
    await sendNotice(stringToHex(JSON.stringify({
      type: remainingMinted === 0n ? "subwallet_unlocked" : "spoofed_wwart_burned",
      subAddress: subNorm,
      vaultAddress,
      verified: true,
      locked: remainingMinted > 0n,
      burnedE8: burnedAmount.toString(),
      remainingMintedE8: remainingMinted.toString(),
      owner: ownerLower || null,
      timestamp: Date.now(),
      message:
        remainingMinted === 0n
          ? "Vault fully unlocked after spoofed wWART burn — withdraw native WART with client-derived vault key (mnemonic+secret+index)."
          : `Burned ${burnedAmount} E8 spoofed wWART; ${remainingMinted} E8 still locks the vault.`,
    })));

    // Phase 3: binding freeable ticket for cosigner (wart-release-ticket-v1)
    if (vaultAddress && burnedAmount > 0n) {
      const vKey = vaultAddress;
      let rel = vaultReleaseState.get(vKey) || {
        nextNonce: 1,
        cumulativeBurnedE8: 0n,
        tickets: [],
      };
      const nonce = rel.nextNonce++;
      rel.cumulativeBurnedE8 += burnedAmount;
      const ticketId = `${vKey.slice(0, 12)}:${nonce}`;
      const ticket = {
        type: "release_ticket",
        scheme: "wart-release-ticket-v1",
        ticketId,
        nonce,
        vaultAddress: vKey,
        subAddress: subNorm,
        owner: ownerLower || null,
        amountE8: burnedAmount.toString(),
        burnedE8: burnedAmount.toString(),
        remainingMintedE8: remainingMinted.toString(),
        cumulativeBurnedE8: rel.cumulativeBurnedE8.toString(),
        fullyUnlocked: remainingMinted === 0n,
        timestamp: Date.now(),
        message:
          "Freeable collateral ticket — compliant cosigner may release up to amountE8 of vault WART",
      };
      rel.tickets.push({
        ticketId,
        nonce,
        amountE8: burnedAmount.toString(),
        timestamp: ticket.timestamp,
      });
      // Cap in-memory ticket log
      if (rel.tickets.length > 500) rel.tickets = rel.tickets.slice(-500);
      vaultReleaseState.set(vKey, rel);

      await sendNotice(stringToHex(JSON.stringify(ticket)));
      console.log(
        `[sub_unlock] release_ticket ${ticketId} amountE8=${burnedAmount} vault=${vKey.slice(0, 12)}…`,
      );
    }

    console.log(
      `[sub_unlock] SUCCESS: ${subNorm} burned ${burnedAmount}; remaining ${remainingMinted}; locked=${remainingMinted > 0n}`,
    );

    return "accept";
  }

  if (input?.type === "sweep_lock") {
    console.log("Processing sweep_lock input:", input);

    const { subAddress, sweepProof, index: subIndex } = input;

    if (!subAddress || !sweepProof) {
      console.log("[sweep_lock] Missing fields — rejecting");
      return "reject";
    }

    const sweepTx = normalizeWarthogTx(sweepProof);
    if (!sweepTx || !sweepTx.fromAddress || !sweepTx.toAddress || !(Number(sweepTx.amountE8) > 0)) {
      console.log("[sweep_lock] Invalid / empty sweep proof — rejecting", sweepTx);
      return "reject";
    }

    const fromNorm = String(sweepTx.fromAddress).replace(/^0x/i, "").toLowerCase();
    const toNorm = String(sweepTx.toAddress).replace(/^0x/i, "").toLowerCase();
    const subNorm = String(subAddress).replace(/^0x/i, "").toLowerCase();
    if (fromNorm !== subNorm) {
      console.log("[sweep_lock] Sweep fromAddress !== subAddress — rejecting");
      return "reject";
    }

    /**
     * Resolve pending context:
     * 1) Optional: sub_lock wrote pendingLocks[sub] (any inbound to sub is fine)
     * 2) Direct fund path (preferred for peer→sub or skip-sub_lock):
     *    reconstruct from proven sweep sub→vault + client vaultAddress + L1 owner.
     * Deposit origin (main vs peer) is never checked — only the sweep proof is.
     */
    let pending = pendingLocks.get(subAddress) || pendingLocks.get(subNorm);

    // Personal vault metadata (create_vault) — advisory only; never override on-chain toAddr
    let personalBySub = null;
    for (const [, p] of personalVaults) {
      if (
        p.subAddress &&
        String(p.subAddress).replace(/^0x/i, "").toLowerCase() === subNorm
      ) {
        personalBySub = p;
        break;
      }
    }

    if (!pending) {
      console.log(
        "[sweep_lock] No pendingLocks — direct fund / recovery from sweep proof",
      );

      // Authoritative vault = where the WART actually landed on Warthog
      let vaultAddress = toNorm;
      if (input.vaultAddress && isWartAddressHex(input.vaultAddress)) {
        const clientVault = String(input.vaultAddress)
          .replace(/^0x/i, "")
          .toLowerCase();
        if (clientVault !== toNorm) {
          console.log(
            `[sweep_lock] Client vault ${clientVault} !== sweep to ${toNorm} — rejecting`,
          );
          return "reject";
        }
      }

      if (!vaultAddress) {
        console.log("[sweep_lock] Cannot resolve vaultAddress for direct fund — rejecting");
        return "reject";
      }

      const ownerRaw =
        input.owner ||
        input.recipient ||
        personalBySub?.owner ||
        sender;
      if (!ownerRaw) {
        console.log("[sweep_lock] No L1 owner for direct fund path — rejecting");
        return "reject";
      }

      // Mint 1:1 against *this sweep* amount (any source funds on sub)
      const mintedAmount = BigInt(String(sweepTx.amountE8));
      pending = {
        owner: String(ownerRaw).toLowerCase(),
        proof: null,
        vaultAddress,
        mintedAmount,
        depositTxHash: sweepTx.txHash || null,
        scheme: "direct-sweep",
      };
      console.log(
        `[sweep_lock] Direct fund: owner=${pending.owner} vault=${vaultAddress} mintedE8=${mintedAmount}`,
      );
    }

    // Normalize pending vault for compare
    const pendingVault = String(pending.vaultAddress).replace(/^0x/i, "").toLowerCase();
    if (toNorm !== pendingVault) {
      console.log(
        `[sweep_lock] Invalid sweep: to=${toNorm} expected vault=${pendingVault} — rejecting`,
      );
      return "reject";
    }

    // Always credit proven sweep amount (1:1 spoofed wWART). Deposit proof amount is advisory.
    const sweepAmt = BigInt(String(sweepTx.amountE8 || 0));
    let mintedAmount = sweepAmt > 0n ? sweepAmt : BigInt(pending.mintedAmount || 0n);
    if (
      pending.mintedAmount != null &&
      sweepAmt > 0n &&
      BigInt(pending.mintedAmount) !== sweepAmt
    ) {
      console.log(
        `[sweep_lock] Pending deposit mint ${pending.mintedAmount} vs sweep ${sweepAmt} — using sweep amount (direct fund OK)`,
      );
    }
    if (mintedAmount <= 0n) {
      console.log("[sweep_lock] Zero mint amount — rejecting");
      return "reject";
    }

    pendingLocks.delete(subAddress);
    pendingLocks.delete(subNorm);

    let vault = userVaults.get(pendingVault) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n,
    };

    // Collateral is E8 on spoofedMinted only — never write E8 into wWART (18-dec portal field).
    // Mixing units made withdraw balances / UI look doubled or show bogus "wWART" amounts.
    vault.spoofedMinted += mintedAmount;
    userVaults.set(pendingVault, vault);

    // Credit L1 owner vault so WalletIsland inspect shows locked capacity
    const ownerLower = pending.owner;
    let ownerVault = userVaults.get(ownerLower) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n,
    };
    ownerVault.spoofedMinted += mintedAmount;
    userVaults.set(ownerLower, ownerVault);

    const personal = personalVaults.get(ownerLower);
    if (personal) {
      personal.fundedE8 = (personal.fundedE8 || 0n) + mintedAmount;
      personal.locked = true;
      personal.vaultAddress = pendingVault;
      personalVaults.set(ownerLower, personal);
    } else if (subIndex !== undefined && subIndex !== null) {
      // Record personal vault from direct sweep so later unlocks work
      personalVaults.set(ownerLower, {
        owner: ownerLower,
        subAddress: subNorm,
        subIndex,
        vaultAddress: pendingVault,
        assetHash: null,
        assetName: null,
        fundedE8: mintedAmount,
        locked: true,
        scheme: pending.scheme || "client-secret-v1",
      });
    }

    // Accumulate if already locked (multiple sweeps)
    const existing = subLocks.get(subNorm) || subLocks.get(subAddress);
    const prevMinted = existing?.minted ? BigInt(existing.minted) : 0n;
    subLocks.set(subNorm, {
      locked: true,
      owner: ownerLower,
      proof: pending.proof,
      minted: prevMinted + mintedAmount,
      vaultAddress: pendingVault,
    });

    const history = userMintHistories.get(ownerLower) || [];
    history.push({
      amount: mintedAmount,
      subAddress: subNorm,
      timestamp: Date.now(),
      txHash: sweepTx.txHash || pending.depositTxHash,
    });
    userMintHistories.set(ownerLower, history);

    await sendNotice(
      stringToHex(
        JSON.stringify({
          type: "sweep_locked",
          subAddress: subNorm,
          locked: true,
          vaultAddress: pendingVault,
          mintedE8: mintedAmount.toString(),
          assetHash: personal?.assetHash || null,
          assetName: personal?.assetName || null,
          owner: ownerLower,
          scheme: pending.scheme || "sub_lock",
          timestamp: Date.now(),
          verified: true,
          message: personal?.assetHash
            ? `Vault funded and linked to native token ${personal.assetName || personal.assetHash}`
            : "Sweep confirmed — spoofed wWART minted 1:1; vault locked until burn/unlock",
        }),
      ),
    );

    console.log(
      `[sweep_lock] SUCCESS: ${subNorm} locked for ${ownerLower} with ${mintedAmount} spoofed wWART → vault ${pendingVault}`,
    );

    return "accept";
  }

  return "accept";
};

// === INSPECT HANDLER ===
const handleInspect = async (rawPayload) => {
  console.log("INSPECT REQUEST - RAW PAYLOAD:", rawPayload || "NO PAYLOAD");

  let path = "";
  if (typeof rawPayload === "string" && rawPayload.startsWith("0x")) {
    try {
      path = Buffer.from(rawPayload.slice(2), "hex").toString("utf-8");
      console.log("SUCCESSFULLY DECODED PATH:", path);
    } catch (e) {
      console.log("FAILED TO DECODE HEX PAYLOAD:", e.message);
      return "accept";
    }
  } else if (typeof rawPayload === "string") {
    path = rawPayload;
    console.log("PATH WAS ALREADY STRING (unusual):", path);
  } else {
    console.log("UNEXPECTED PAYLOAD TYPE:", typeof rawPayload);
    return "accept";
  }

  // Path A pool inspect: pool / pool/wart-pool-0 / pool/<ownerEth>
  const pathLower = path.toLowerCase().replace(/^\/+/, "");
  if (pathLower === "pool" || pathLower.startsWith("pool/")) {
    const rest = pathLower === "pool" ? "" : pathLower.slice(5);
    let owner = null;
    if (rest && rest !== fungiblePool.poolId && rest !== "wart-pool-0") {
      owner = rest.startsWith("0x") ? rest : "0x" + rest;
    }
    const snap = poolSnapshot(owner);
    await sendReport(stringToHex(JSON.stringify({ ok: true, ...snap })));
    console.log("POOL INSPECT SENT", owner || "global");
    return "accept";
  }

  if (path.toLowerCase().includes("vault")) {
    console.log("VAULT INSPECT DETECTED - DECODED PATH:", path);

    let address = path.toLowerCase().replace(/^\/+/, '');

    if (address.startsWith("vault/")) {
      address = address.slice(6);
    } else if (address.startsWith("vault")) {
      address = address.slice(5);
    }

    if (!address.startsWith("0x")) {
      address = "0x" + address;
    }
    address = address.toLowerCase();

    // Tolerate mixed casing; require 40 hex after 0x
    const bare = address.slice(2);
    if (!/^[a-f0-9]{40}$/.test(bare)) {
      console.log("INVALID ADDRESS EXTRACTED:", address, "len", bare.length);
      await sendReport(stringToHex(JSON.stringify({
        error: "Invalid Ethereum address",
        got: address,
        hint: "Use 0x + 40 hex (MetaMask address). Spoofed wWART is keyed by L1 owner.",
      })));
      return "accept";
    }
    address = "0x" + bare;

    console.log("QUERYING VAULT FOR ADDRESS:", address);

    // Look up with 0x prefix (primary); also try bare for legacy keys
    const vault =
      userVaults.get(address) ||
      userVaults.get(bare) || {
        liquid: 0n,
        wWART: 0n,
        CTSI: 0n,
        usdc: 0n,
        eth: 0n,
        spoofedMinted: 0n,
        spoofedBurned: 0n,
      };

    const mintHistory =
      userMintHistories.get(address) || userMintHistories.get(bare) || [];
    const burnHistory =
      userBurnHistories.get(address) || userBurnHistories.get(bare) || [];
    // Prefer history sum; fall back to vault.spoofedMinted if history empty but vault credited
    let totalSpoofedMintedE8 = mintHistory.reduce((sum, m) => sum + BigInt(m.amount), 0n);
    let totalSpoofedBurnedE8 = burnHistory.reduce((sum, b) => sum + BigInt(b.amount), 0n);
    if (totalSpoofedMintedE8 === 0n && vault.spoofedMinted > 0n) {
      totalSpoofedMintedE8 = vault.spoofedMinted;
    }
    if (totalSpoofedBurnedE8 === 0n && vault.spoofedBurned > 0n) {
      totalSpoofedBurnedE8 = vault.spoofedBurned;
    }

    const personal =
      personalVaults.get(address) || personalVaults.get(bare) || null;

    // Release-ticket summary for cosigner / UI (by personal Wart vault or owner burns)
    let releaseSummary = null;
    const wartVault = personal?.vaultAddress
      ? String(personal.vaultAddress).replace(/^0x/i, "").toLowerCase()
      : null;
    if (wartVault && vaultReleaseState.has(wartVault)) {
      const rel = vaultReleaseState.get(wartVault);
      releaseSummary = {
        vaultAddress: wartVault,
        ticketCount: rel.tickets.length,
        nextNonce: rel.nextNonce,
        cumulativeBurnedE8: rel.cumulativeBurnedE8.toString(),
        recentTickets: rel.tickets.slice(-10),
      };
    }

    const outstandingE8 =
      totalSpoofedMintedE8 > totalSpoofedBurnedE8
        ? totalSpoofedMintedE8 - totalSpoofedBurnedE8
        : 0n;

    // Mint capacity = locked WART only (history preferred). Portal ETH/CTSI/USDC
    // are inventory balances — not shared mint headroom with wWART claims.
    let spoofedOut = outstandingE8;
    if (totalSpoofedMintedE8 === 0n && totalSpoofedBurnedE8 === 0n) {
      const m = vault.spoofedMinted || 0n;
      const b = vault.spoofedBurned || 0n;
      spoofedOut = m > b ? m - b : 0n;
    }
    const capacity18 = spoofedOut * 10n ** 10n;
    const claimed18 = (vault.liquid || 0n) + (vault.l1WwartClaim || 0n);
    const remaining18 = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;

    // Path B personal portal wWART (18-dec). Legacy E8 pollution hidden.
    const portalWwartReport = portalWwart18Of(vault.wWART);
    // Path A pool portal — isolated; cannot cover personal burns and vice versa.
    const poolPortalReport = portalWwart18Of(vault.poolPortalWwart);

    // Open = still portable (not withdrawn); filled = claim held while ERC-20 is on L1.
    // Burnable = min(claim, portable + same-path portal inventory).
    const claimR = vault.l1WwartClaim || 0n;
    const portableR = vault.wwartPortable || 0n;
    const openClaimR = portableR < claimR ? portableR : claimR;
    const filledClaimR = claimR > openClaimR ? claimR - openClaimR : 0n;
    const coverableR = portableR + portalWwartReport;
    const burnableR = claimR < coverableR ? claimR : coverableR;

    const poolClaimR = vault.poolL1WwartClaim || 0n;
    const poolPortableR = vault.poolWwartPortable || 0n;
    const poolOpenR = poolPortableR < poolClaimR ? poolPortableR : poolClaimR;
    const poolFilledR = poolClaimR > poolOpenR ? poolClaimR - poolOpenR : 0n;
    const poolCoverableR = poolPortableR + poolPortalReport;
    const poolBurnableR =
      poolClaimR < poolCoverableR ? poolClaimR : poolCoverableR;

    const isRegistered =
      registeredUsers.get(address) === true ||
      registeredUsers.get(bare) === true ||
      registeredUsers.get("0x" + bare) === true;

    const reportPayload = stringToHex(JSON.stringify({
      liquid: vault.liquid.toString(),
      /** Path B personal portal inventory only */
      wWART: portalWwartReport.toString(),
      wwartPortable: (vault.wwartPortable || 0n).toString(),
      l1WwartClaim: (vault.l1WwartClaim || 0n).toString(),
      // Explicit open / filled / burnable for UI (filled must deposit L1 before burn frees Used)
      wwartOpenClaim: openClaimR.toString(),
      wwartFilledClaim: filledClaimR.toString(),
      wwartBurnable: burnableR.toString(),
      /** Path A pool portal inventory (isolated from wWART personal portal) */
      poolPortalWwart: poolPortalReport.toString(),
      poolWwartOpenClaim: poolOpenR.toString(),
      poolWwartFilledClaim: poolFilledR.toString(),
      poolWwartBurnable: poolBurnableR.toString(),
      CTSI: vault.CTSI.toString(),
      usdc: vault.usdc.toString(),
      eth: formatEther(vault.eth),
      /** ETH inventory in wei (same as eth human field; for exact UI) */
      ethWei: (vault.eth || 0n).toString(),
      /**
       * Indexed ETH deposit sub-wallets (ETH→WART bridge step 1).
       * Not mint capacity — portal inventory only.
       */
      ethSubs: (() => {
        const byIdx =
          ethSubsByOwner.get(address) ||
          ethSubsByOwner.get(bare) ||
          ethSubsByOwner.get("0x" + bare);
        if (!byIdx || byIdx.size === 0) return [];
        return [...byIdx.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([idx, e]) => ({
            index: idx,
            address: e.address,
            ethWei: (e.ethWei || 0n).toString(),
            eth: formatEther(e.ethWei || 0n),
            path: e.path || null,
          }));
      })(),
      /** Cosigner ETH vaults + locked-ETH capacity (separate from WART) */
      ethVaults: (() => {
        const list =
          ethVaultsByOwner.get(address) ||
          ethVaultsByOwner.get(bare) ||
          ethVaultsByOwner.get("0x" + bare) ||
          [];
        return list.map((r) => {
          const lm = r.lockedMinted || 0n;
          const lb = r.lockedBurned || 0n;
          const out = lm > lb ? lm - lb : 0n;
          return {
            vaultAddress: r.vaultAddress,
            ethSubAddress: r.ethSubAddress,
            index: r.index,
            scheme: r.scheme,
            lockedOutstandingWei: out.toString(),
            lockedOutstanding: formatEther(out),
            lockedMintedWei: lm.toString(),
            lockedBurnedWei: lb.toString(),
          };
        });
      })(),
      ethLockedMinted: (vault.ethLockedMinted || 0n).toString(),
      ethLockedBurned: (vault.ethLockedBurned || 0n).toString(),
      ethLockedOutstanding: ethLockedOutstandingWei(vault).toString(),
      ethCapacity18: ethBackingCapacity18(vault).toString(),
      ethClaimed18: ethShareClaimed18(vault).toString(),
      ethRemaining18: (() => {
        const c = ethBackingCapacity18(vault);
        const u = ethShareClaimed18(vault);
        return (c > u ? c - u : 0n).toString();
      })(),
      l1WethClaim: (vault.l1WethClaim || 0n).toString(),
      wethPortable: (vault.wethPortable || 0n).toString(),
      /** Native Warthog ETH assets linked to claims (newest last) */
      ethWartAssets: Array.isArray(vault.ethWartAssets)
        ? vault.ethWartAssets.slice().reverse()
        : [],
      /** true once this L1 owner has submitted register_address */
      registered: isRegistered,
      spoofedMintHistory: mintHistory.map(m => ({...m, amount: m.amount.toString()})),
      spoofedBurnHistory: burnHistory.map(b => ({...b, amount: b.amount.toString()})),
      totalSpoofedMinted: totalSpoofedMintedE8.toString(),
      totalSpoofedBurned: totalSpoofedBurnedE8.toString(),
      outstandingE8: outstandingE8.toString(),
      freeableFromBurnsE8: totalSpoofedBurnedE8.toString(),
      mintCapacity18: capacity18.toString(),
      mintClaimed18: claimed18.toString(),
      mintRemaining18: remaining18.toString(),
      /** Path A pool claims (not personal vault capacity) */
      poolL1WwartClaim: (vault.poolL1WwartClaim || 0n).toString(),
      poolWwartPortable: (vault.poolWwartPortable || 0n).toString(),
      /** Alias for clarity in clients */
      poolPortalInventory: poolPortalReport.toString(),
      fungiblePool: poolSnapshot(address),
      releaseTickets: releaseSummary,
      personalVault: personal ? {
        vaultAddress: personal.vaultAddress,
        subAddress: personal.subAddress,
        subIndex: personal.subIndex,
        assetHash: personal.assetHash,
        assetName: personal.assetName,
        fundedE8: personal.fundedE8.toString(),
        locked: personal.locked,
      } : null,
    }));
    await sendReport(reportPayload);
    console.log("VAULT REPORT SENT FOR:", address);
  } else {
    console.log("Non-vault inspect path - ignored:", path);
  }

  return "accept";
};

// === MAIN LOOP ===
async function main() {
  let status = "accept";

  while (true) {
    const finishRes = await fetch(`${rollupServer}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (finishRes.status === 200) {
      const data = await finishRes.json();

      if (data.request_type === "advance_state") {
        status = await handleAdvance(data.data);
      } else if (data.request_type === "inspect_state") {
        let inspectPath = null;

        if (data.data && typeof data.data === "object") {
          if (data.data.path !== undefined) {
            inspectPath = data.data.path;
          } else if (data.data.payload !== undefined) {
            inspectPath = data.data.payload;
          } else {
            inspectPath = JSON.stringify(data.data);
          }
        } else if (data.data) {
          inspectPath = data.data;
        }

        console.log("INSPECT REQUEST - Extracted path:", inspectPath);
        status = await handleInspect(inspectPath);
      }
    } else {
      console.error("Finish error:", finishRes.status);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

main().catch((err) => {
  console.error("DApp crashed:", err);
  process.exit(1);
});