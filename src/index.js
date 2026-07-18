console.log("[cartesi-bridge-backend] dApp starting — vaults, sub_lock/sweep, ETH/ERC20, liquid mint");

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const { Wallet } = require("cartesi-wallet");
const { stringToHex, hexToString } = require("viem");
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
const WWART_ADDRESS = (process.env.WWART_ADDRESS || "0x0000000000000000000000000000000000000000").toLowerCase();
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

  creditToVault(vaults, depositor, amountWei) {
    let vault = vaults.get(depositor) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n
    };
    vault.eth += amountWei;
    vaults.set(depositor, vault);
  },

  createDepositNotice(depositor, amountWei) {
    const vault = userVaults.get(depositor);
    return {
      type: "eth_deposited",
      user: depositor,
      amount: amountWei.toString(),
      newBalance: vault?.eth.toString() ?? "0"
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

// ERC-20 transfer voucher (dApp holds tokens after portal deposit → transfer out)
const ERC20 = {
  TRANSFER_SELECTOR: "0xa9059cbb", // transfer(address,uint256)

  buildTransferPayload(recipient, amount) {
    const to = String(recipient).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
    const amt = BigInt(amount).toString(16).padStart(64, "0");
    return "0x" + this.TRANSFER_SELECTOR.slice(2) + to + amt;
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
  if (!vault || vault[tokenKey] < amount) {
    console.log(`Insufficient ${tokenKey} balance`);
    return "reject";
  }
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    console.log(`${tokenKey} token address not configured`);
    return "reject";
  }

  vault[tokenKey] -= amount;
  userVaults.set(user, vault);

  try {
    const payload = ERC20.buildTransferPayload(user, amount);
    await ERC20.emitVoucher(tokenAddress, payload);
    await sendNotice(stringToHex(JSON.stringify({
      type: noticeType,
      user,
      amount: amount.toString(),
      newBalance: vault[tokenKey].toString(),
    })));
    console.log(`*** ${tokenKey} WITHDRAWAL: ${amount} → ${user} ***`);
    return "accept";
  } catch (e) {
    vault[tokenKey] += amount;
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

  // 2. USER REGISTERS THEIR ADDRESS
  if (input?.type === "register_address") {
    const user = sender;
    registeredUsers.set(user, true);

    await sendNotice(stringToHex(JSON.stringify({ type: "address_registered", user })));
    console.log("Received register_address from", user);
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

    console.log(`Crediting ${formatEther(amountWei)} ETH to ${depositor}`);

    ETH.creditToVault(userVaults, depositor, amountWei);

    const noticePayload = ETH.createDepositNotice(depositor, amountWei);
    await sendNotice(stringToHex(JSON.stringify(noticePayload)));

    console.log(`*** ETH DEPOSIT CREDITED: ${formatEther(amountWei)} ETH → ${depositor} ***`);

    return "accept";
  }

  // 4. ERC-20 DEPOSITS (wWART, CTSI, USDC) ─ unchanged
  if (sender === ERC20Portal) {
    console.log("ERC20 PORTAL INPUT RECEIVED - PAYLOAD:", request.payload);

    let tokenAddress = "", depositor = "", amount = 0n;

    try {
      const data = request.payload.slice(2);
      tokenAddress = "0x" + data.slice(0, 40).toLowerCase();
      depositor    = "0x" + data.slice(40, 80).toLowerCase();
      const amountHex = "0x" + data.slice(80, 144);
      amount = BigInt(amountHex);

      console.log("Parsed token:", tokenAddress);
      console.log("Parsed depositor:", depositor);
      console.log("Parsed amount:", amount.toString());
    } catch (e) {
      console.error("ERC20 payload parsing error:", e);
      return "reject";
    }

    if (amount === 0n) return "accept";

    let vault = userVaults.get(depositor) || {
      liquid: 0n, wWART: 0n, CTSI: 0n, usdc: 0n, eth: 0n,
      spoofedMinted: 0n, spoofedBurned: 0n
    };

    let type = "unknown";
    if (tokenAddress === WWART_ADDRESS.toLowerCase()) {
      vault.wWART += amount; type = "wwart_deposited";
    } else if (tokenAddress === CTSI_ADDRESS.toLowerCase()) {
      vault.CTSI += amount; type = "ctsi_deposited";
    } else if (tokenAddress === USDC_ADDRESS.toLowerCase()) {
      vault.usdc += amount; type = "usdc_deposited";
    } else {
      console.log("Unknown token — ignoring");
      return "accept";
    }

    userVaults.set(depositor, vault);

    await sendNotice(stringToHex(JSON.stringify({
      type,
      user: depositor,
      amount: amount.toString(),
      newBalance: type === "wwart_deposited" ? vault.wWART.toString() :
                  type === "ctsi_deposited" ? vault.CTSI.toString() :
                  vault.usdc.toString()
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
  if (input?.type === "withdraw_wwart") {
    return withdrawErc20FromVault(sender, "wWART", WWART_ADDRESS, BigInt(input.amount), "wwart_withdrawn");
  }
  if (input?.type === "withdraw_ctsi") {
    return withdrawErc20FromVault(sender, "CTSI", CTSI_ADDRESS, BigInt(input.amount), "ctsi_withdrawn");
  }
  if (input?.type === "withdraw_usdc") {
    return withdrawErc20FromVault(sender, "usdc", USDC_ADDRESS, BigInt(input.amount), "usdc_withdrawn");
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

  /** Convert vault backing fields into 18-dec share capacity. */
  const backingCapacity18 = (vault) => {
    // wWART from sweep_lock is E8 (8 decimals) → 18-dec: * 10^10
    const fromWwartE8 = (vault.wWART || 0n) * 10n ** 10n;
    const fromCtsi = vault.CTSI || 0n; // already 18-dec from portals
    const fromEth = vault.eth || 0n; // wei 18-dec
    // USDC 6-dec → 18-dec
    const fromUsdc = (vault.usdc || 0n) * 10n ** 12n;
    return fromWwartE8 + fromCtsi + fromEth + fromUsdc;
  };

  if (input?.type === "mint_liquid" || input?.type === "mint_wliq") {
    const user = sender;
    let vault = userVaults.get(user) || {
      liquid: 0n, wWART: 0n, CTSI: 0n, usdc: 0n, eth: 0n, spoofedMinted: 0n, spoofedBurned: 0n,
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

    const capacity = backingCapacity18(vault);
    const already = vault.liquid || 0n;
    const remaining = capacity > already ? capacity - already : 0n;

    // If no backing yet, allow small demo mint only when amount ≤ 1 WLIQ
    let mintAmt;
    if (capacity === 0n) {
      const demoCap = 10n ** 18n; // 1 WLIQ demo
      mintAmt = requested > demoCap ? demoCap : requested;
      console.log(`[mint_wliq] no backing — demo mint ${mintAmt}`);
    } else {
      if (remaining === 0n) {
        console.log("[mint_wliq] capacity fully minted — rejecting");
        return "reject";
      }
      mintAmt = requested > remaining ? remaining : requested;
    }

    vault.liquid += mintAmt;
    userVaults.set(user, vault);
    await sendNotice(stringToHex(JSON.stringify({
      type: "wliq_minted",
      // keep legacy type for older UIs
      legacyType: "liquid_minted",
      token: "WLIQ",
      user,
      amount: mintAmt.toString(),
      requested: requested.toString(),
      newBalance: vault.liquid.toString(),
      capacity: capacity.toString(),
      remaining: (capacity > vault.liquid ? capacity - vault.liquid : 0n).toString(),
    })));
    console.log(`[mint_wliq] ${user} +${mintAmt} → balance ${vault.liquid}`);
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
    await sendNotice(stringToHex(JSON.stringify({
      type: "wliq_burned",
      legacyType: "liquid_burned",
      token: "WLIQ",
      user,
      amount: amount.toString(),
      newBalance: vault.liquid.toString(),
    })));
    return "accept";
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
    let vault = userVaults.get(vaultAddress);
    if (vault) {
      vault.spoofedBurned = (vault.spoofedBurned || 0n) + burnedAmount;
      // Debit rollup-side spoofed wWART / wWART credit (collateral accounting)
      if (vault.wWART >= burnedAmount) vault.wWART -= burnedAmount;
      else vault.wWART = 0n;
      if (vault.spoofedMinted >= burnedAmount) vault.spoofedMinted -= burnedAmount;
      else vault.spoofedMinted = 0n;
      userVaults.set(vaultAddress, vault);
    }

    // Mirror debit on L1 owner vault (WalletIsland inspect)
    const ownerLower = (subLock.owner || sender || "").toLowerCase();
    if (ownerLower) {
      let ownerVault = userVaults.get(ownerLower);
      if (ownerVault) {
        ownerVault.spoofedBurned = (ownerVault.spoofedBurned || 0n) + burnedAmount;
        if (ownerVault.wWART >= burnedAmount) ownerVault.wWART -= burnedAmount;
        else ownerVault.wWART = 0n;
        if (ownerVault.spoofedMinted >= burnedAmount) ownerVault.spoofedMinted -= burnedAmount;
        else ownerVault.spoofedMinted = 0n;
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

    // Keep L1 owner mint history in sync for WalletIsland totals
    if (ownerLower) {
      const hist = userMintHistories.get(ownerLower) || [];
      // Append a synthetic negative via burn history only; totals = mint sum - burn sum on inspect
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

    vault.spoofedMinted += mintedAmount;
    vault.wWART += mintedAmount;
    userVaults.set(pendingVault, vault);

    // Credit L1 owner vault so WalletIsland inspect shows bridged balance
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
    ownerVault.wWART += mintedAmount;
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

    const reportPayload = stringToHex(JSON.stringify({
      liquid: vault.liquid.toString(),
      wWART: vault.wWART.toString(),
      CTSI: vault.CTSI.toString(),
      usdc: vault.usdc.toString(),
      eth: formatEther(vault.eth),
      spoofedMintHistory: mintHistory.map(m => ({...m, amount: m.amount.toString()})),
      spoofedBurnHistory: burnHistory.map(b => ({...b, amount: b.amount.toString()})),
      totalSpoofedMinted: totalSpoofedMintedE8.toString(),
      totalSpoofedBurned: totalSpoofedBurnedE8.toString(),
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