/**
 * Phase 3 SPV — Warthog light-client deposits (in-machine).
 *
 * Verifies:
 *  1. Header integrity: sha256d(raw) == hash; prevHash/merkleroot from raw
 *  2. Janus8 PoW via janushash-check (VerusHash v2.2 × SHA256t vs TargetV2)
 *  3. Header chain links (prevHash)
 *  4. Body inclusion: SHA256 leaves (reward + entry txs) → merkle root == header.merkleroot
 *  5. Deposit transfer: toAccountId == pool account, amountE8 from binary
 *  6. Finality: confirmations vs tip, or height <= pinHeight with pinHash match
 *
 * See docs/PHASE-3-SPV-ATOMIC-DEPOSIT.md
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HEADER_SIZE = 80;
const OFF_PREV = 0;
const OFF_TARGET = 32;
const OFF_MERKLE = 36;
const OFF_VERSION = 68;
const OFF_TIMESTAMP = 72;
const OFF_NONCE = 76;

/** Tags that form individual merkle leaves (not containers / meta). */
const MERKLE_LEAF_TAGS = new Set([
  "reward",
  "wartTransfer",
  "tokenTransfer",
  "limitSwap",
  "match",
  "liquidityDeposit",
  "liquidityWithdrawal",
  "assetCreation",
  "cancelation",
]);

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function sha256d(buf) {
  return sha256(sha256(buf));
}

function hexNorm(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/^0x/, "");
}

function hexToBuf(h) {
  const s = hexNorm(h);
  if (!s || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) {
    throw new Error("invalid hex");
  }
  return Buffer.from(s, "hex");
}

function bufToHex(b) {
  return Buffer.from(b).toString("hex");
}

/**
 * Parse 80-byte Warthog header raw.
 */
function parseHeaderRaw(rawHex) {
  const raw = hexToBuf(rawHex);
  if (raw.length !== HEADER_SIZE) {
    throw new Error(`header raw must be ${HEADER_SIZE} bytes, got ${raw.length}`);
  }
  const hash = bufToHex(sha256d(raw));
  return {
    raw: bufToHex(raw),
    hash,
    prevHash: bufToHex(raw.subarray(OFF_PREV, OFF_PREV + 32)),
    target: bufToHex(raw.subarray(OFF_TARGET, OFF_TARGET + 4)),
    merkleroot: bufToHex(raw.subarray(OFF_MERKLE, OFF_MERKLE + 32)),
    version: raw.readUInt32BE(OFF_VERSION),
    timestamp: raw.readUInt32BE(OFF_TIMESTAMP),
    nonce: bufToHex(raw.subarray(OFF_NONCE, OFF_NONCE + 4)),
  };
}

/**
 * Resolve janushash-check binary (Cartesi machine or host dev tree).
 */
function resolveJanushashBin() {
  if (process.env.JANUSHASH_CHECK) return process.env.JANUSHASH_CHECK;
  const candidates = [
    "/opt/cartesi/bin/janushash-check",
    path.join(__dirname, "..", "native", "janushash", "janushash-check"),
    path.join(__dirname, "..", "..", "bin", "janushash-check"),
    "/opt/cartesi-bridge/bin/janushash-check",
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* */
    }
  }
  return null;
}

/**
 * Janus8 PoW: VerusHash v2.2 × SHA256t vs TargetV2 (warthog testnet/current).
 * Requires janushash-check binary (Warthog portable Verus).
 */
function verifyHeaderPow(rawHex, opts = {}) {
  const requirePow = opts.requirePow !== false && process.env.WART_SPV_REQUIRE_POW !== "0";
  const bin = resolveJanushashBin();
  if (!bin) {
    if (requirePow) {
      throw new Error("janushash-check binary not found (set JANUSHASH_CHECK)");
    }
    return { skipped: true, ok: true };
  }
  const raw = hexNorm(rawHex);
  let out;
  try {
    out = execFileSync(bin, [raw], {
      encoding: "utf8",
      timeout: Number(opts.timeoutMs || 30_000),
      maxBuffer: 256 * 1024,
    });
  } catch (e) {
    // exit 1 = invalid PoW with JSON on stdout
    const stdout = e?.stdout ? String(e.stdout) : "";
    if (stdout.trim().startsWith("{")) {
      try {
        const j = JSON.parse(stdout.trim().split("\n")[0]);
        if (j.ok === false) {
          throw new Error(
            `Janus8 PoW invalid janusNumber=${j.janusNumber} verus=${String(j.verusHash || "").slice(0, 16)}…`,
          );
        }
      } catch (inner) {
        if (String(inner.message || "").includes("PoW invalid")) throw inner;
      }
    }
    throw new Error(`janushash-check failed: ${e?.message || e}`);
  }
  const line = String(out).trim().split("\n")[0];
  const j = JSON.parse(line);
  if (!j.ok) {
    throw new Error(`Janus8 PoW invalid janusNumber=${j.janusNumber}`);
  }
  // Cross-check block hash vs sha256d(raw)
  const parsed = parseHeaderRaw(raw);
  if (hexNorm(j.blockHash) !== parsed.hash) {
    throw new Error("janushash-check blockHash != sha256d(raw)");
  }
  return {
    skipped: false,
    ok: true,
    verusHash: hexNorm(j.verusHash),
    sha256t: hexNorm(j.sha256t),
    janusNumber: j.janusNumber,
    blockHash: hexNorm(j.blockHash),
  };
}

/**
 * Verify claimed header fields against raw + Janus8 PoW.
 */
function verifyHeader(header, opts = {}) {
  if (!header?.raw) throw new Error("header.raw required");
  const parsed = parseHeaderRaw(header.raw);
  if (header.hash && hexNorm(header.hash) !== parsed.hash) {
    throw new Error("header.hash != sha256d(raw)");
  }
  if (header.prevHash && hexNorm(header.prevHash) !== parsed.prevHash) {
    throw new Error("header.prevHash mismatch raw");
  }
  if (header.merkleroot && hexNorm(header.merkleroot) !== parsed.merkleroot) {
    throw new Error("header.merkleroot mismatch raw");
  }
  const pow = verifyHeaderPow(parsed.raw, opts);
  parsed.pow = pow;
  return parsed;
}

/**
 * Merkle root over leaves (SHA256 digests), Warthog new_root_type (height >= 900000 / testnet).
 * Final combine includes seed = body[0..10) for block v2.
 */
function merkleRootNew(leaves, seedBuf) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error("empty merkle leaves");
  }
  let cur = leaves.map((l) => Buffer.from(l));
  for (;;) {
    const I = Math.floor((cur.length + 1) / 2);
    const nxt = [];
    let j = 0;
    for (let i = 0; i < I; i++) {
      const h = crypto.createHash("sha256");
      h.update(cur[j]);
      if (j + 1 < cur.length) h.update(cur[j + 1]);
      if (I === 1) h.update(seedBuf);
      nxt.push(h.digest());
      j += 2;
    }
    cur = nxt;
    if (cur.length === 1) return cur[0];
  }
}

/**
 * Collect merkle leaf digests from body binary + structure (node API layout).
 */
function collectBodyLeaves(bodyBytes, structure) {
  const body = Buffer.isBuffer(bodyBytes) ? bodyBytes : hexToBuf(bodyBytes);
  const leaves = [];
  function walk(nodes) {
    for (const n of nodes || []) {
      const tag = n.tag;
      if (tag === "reward" || MERKLE_LEAF_TAGS.has(tag)) {
        const a = Number(n.beginOffset);
        const b = Number(n.endOffset);
        if (!(b > a) || b > body.length) {
          throw new Error(`bad leaf range ${tag} ${a}-${b}`);
        }
        leaves.push(sha256(body.subarray(a, b)));
        // reward is one leaf; do not walk children
        if (tag === "reward") continue;
        continue;
      }
      walk(n.children || []);
    }
  }
  walk(structure);
  return { body, leaves };
}

/**
 * Verify body binary commits to header.merkleroot.
 */
function verifyBodyMerkle(bodyHex, structure, merklerootHex) {
  const { body, leaves } = collectBodyLeaves(bodyHex, structure);
  if (body.length < 10) throw new Error("body too short for v2 seed");
  const seed = body.subarray(0, 10);
  const root = merkleRootNew(leaves, seed);
  const want = hexNorm(merklerootHex);
  const got = bufToHex(root);
  if (got !== want) {
    throw new Error(`body merkle root mismatch got=${got.slice(0, 16)} want=${want.slice(0, 16)}`);
  }
  return { body, leaves, root: got };
}

/**
 * Decode a wartTransfer binary segment.
 * Layout (big-endian multi-byte ints, per Warthog body encoding):
 *   originAccountId u64 BE, pinNonce u64 BE, compactFee u16 BE,
 *   toAccountId u64 BE, amountE8 u64 BE, signature…
 */
function decodeWartTransfer(seg) {
  const b = Buffer.isBuffer(seg) ? seg : hexToBuf(seg);
  if (b.length < 34) throw new Error("wartTransfer segment too short");
  return {
    originAccountId: Number(b.readBigUInt64BE(0)),
    pinNonce: Number(b.readBigUInt64BE(8)),
    compactFee: b.readUInt16BE(16),
    toAccountId: Number(b.readBigUInt64BE(18)),
    amountE8: b.readBigUInt64BE(26).toString(),
    bytesHex: bufToHex(b),
  };
}

/**
 * Find pool deposits in body structure.
 */
function findPoolDeposits(bodyHex, structure, poolAccountId) {
  const body = Buffer.isBuffer(bodyHex) ? bodyHex : hexToBuf(bodyHex);
  const poolId = Number(poolAccountId);
  const out = [];
  function walk(nodes) {
    for (const n of nodes || []) {
      if (n.tag === "wartTransfer") {
        const a = Number(n.beginOffset);
        const b = Number(n.endOffset);
        const dec = decodeWartTransfer(body.subarray(a, b));
        if (dec.toAccountId === poolId && BigInt(dec.amountE8) > 0n) {
          out.push({ ...dec, beginOffset: a, endOffset: b });
        }
      }
      walk(n.children || []);
    }
  }
  walk(structure);
  return out;
}

/**
 * Header chain link check (oldest → newest).
 */
/**
 * Link-check header window. PoW is intentionally NOT run on every header
 * (Verus is expensive under RISC-V emu). Call verifyHeader / verifyHeaderPow
 * on the deposit block (and optionally tip) separately.
 */
function verifyHeaderChainLinks(headers) {
  if (!Array.isArray(headers) || headers.length < 1) {
    return { ok: false, reason: "empty headers" };
  }
  const parsed = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    // Structural parse only (sha256d binds fields) — skip Janus PoW here
    let p = null;
    if (h.raw) {
      p = parseHeaderRaw(h.raw);
      if (h.hash && hexNorm(h.hash) !== p.hash) {
        return { ok: false, reason: `hash mismatch at i=${i}` };
      }
    }
    const hash = hexNorm(p?.hash || h.hash);
    const prevHash = hexNorm(p?.prevHash || h.prevHash);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { ok: false, reason: `bad hash at i=${i}` };
    }
    if (!/^[0-9a-f]{64}$/.test(prevHash)) {
      return { ok: false, reason: `bad prevHash at i=${i}` };
    }
    if (i > 0 && prevHash !== parsed[i - 1].hash) {
      return { ok: false, reason: `link break at i=${i}` };
    }
    parsed.push({
      hash,
      prevHash,
      height: h.height != null ? Number(h.height) : null,
      merkleroot: hexNorm(p?.merkleroot || h.merkleroot || ""),
      raw: p?.raw || hexNorm(h.raw || ""),
    });
  }
  return {
    ok: true,
    tip: parsed[parsed.length - 1].hash,
    genesis: parsed[0].hash,
    headers: parsed,
    length: parsed.length,
  };
}

/**
 * Light-client state machine (mutable).
 */
function createLightClient(opts = {}) {
  return {
    bootstrapped: false,
    checkpointHeight: opts.checkpointHeight != null ? Number(opts.checkpointHeight) : null,
    checkpointHash: opts.checkpointHash ? hexNorm(opts.checkpointHash) : null,
    bestHeight: opts.bestHeight != null ? Number(opts.bestHeight) : 0,
    bestHash: opts.bestHash ? hexNorm(opts.bestHash) : null,
    pinHeight: opts.pinHeight != null ? Number(opts.pinHeight) : null,
    pinHash: opts.pinHash ? hexNorm(opts.pinHash) : null,
    /** height -> { hash, prevHash, merkleroot } */
    byHeight: new Map(),
    maxHeaders: Number(opts.maxHeaders || 512),
    minConfirmations: Number(opts.minConfirmations || 1),
    poolAccountId: Number(opts.poolAccountId || 81),
    allowBootstrap: opts.allowBootstrap !== false,
  };
}

function lcSnapshot(lc) {
  return {
    bootstrapped: !!lc.bootstrapped,
    checkpointHeight: lc.checkpointHeight,
    checkpointHash: lc.checkpointHash,
    bestHeight: lc.bestHeight,
    bestHash: lc.bestHash,
    pinHeight: lc.pinHeight,
    pinHash: lc.pinHash,
    headersStored: lc.byHeight.size,
    minConfirmations: lc.minConfirmations,
    poolAccountId: lc.poolAccountId,
    scheme: "wart-spv-lc-v0",
  };
}

/**
 * Apply header batch (oldest → newest) with heights.
 * headers: [{ height, raw|hash, prevHash, ...}]
 */
function applyHeaders(lc, headers, { bootstrap = false, pinHeight = null, pinHash = null } = {}) {
  const chain = verifyHeaderChainLinks(headers);
  if (!chain.ok) throw new Error(`header chain: ${chain.reason}`);

  // Ensure heights present and contiguous
  const hs = chain.headers.map((h, i) => {
    const height = headers[i].height != null ? Number(headers[i].height) : null;
    if (height == null || !Number.isFinite(height)) {
      throw new Error(`header missing height at i=${i}`);
    }
    return { ...h, height };
  });
  for (let i = 1; i < hs.length; i++) {
    if (hs[i].height !== hs[i - 1].height + 1) {
      throw new Error(
        `header heights not contiguous ${hs[i - 1].height} → ${hs[i].height}`,
      );
    }
  }

  if (!lc.bootstrapped) {
    if (!bootstrap && !lc.allowBootstrap) {
      throw new Error("light client not bootstrapped");
    }
    if (!bootstrap && !lc.allowBootstrap) {
      /* unreachable */
    }
    const first = hs[0];
    lc.bootstrapped = true;
    lc.checkpointHeight = first.height;
    lc.checkpointHash = first.hash;
    lc.bestHeight = first.height;
    lc.bestHash = first.hash;
    lc.byHeight.set(first.height, {
      hash: first.hash,
      prevHash: first.prevHash,
      merkleroot: first.merkleroot,
    });
    // apply rest below
    for (let i = 1; i < hs.length; i++) {
      _appendOne(lc, hs[i]);
    }
  } else {
    for (const h of hs) {
      if (lc.byHeight.has(h.height)) {
        const ex = lc.byHeight.get(h.height);
        if (ex.hash !== h.hash) {
          throw new Error(`header conflict at height ${h.height}`);
        }
        continue;
      }
      _appendOne(lc, h);
    }
  }

  if (pinHeight != null && pinHash) {
    const ph = Number(pinHeight);
    const pHash = hexNorm(pinHash);
    const have = lc.byHeight.get(ph);
    if (have) {
      if (have.hash !== pHash) {
        throw new Error("pinHash mismatch stored header");
      }
      lc.pinHeight = ph;
      lc.pinHash = pHash;
    } else if (ph <= lc.bestHeight) {
      // pin older than window — accept pin fields without storage if tip is ahead
      lc.pinHeight = ph;
      lc.pinHash = pHash;
    }
  }

  _trim(lc);
  return lcSnapshot(lc);
}

function _appendOne(lc, h) {
  if (!lc.bestHash) {
    lc.bestHeight = h.height;
    lc.bestHash = h.hash;
    lc.byHeight.set(h.height, {
      hash: h.hash,
      prevHash: h.prevHash,
      merkleroot: h.merkleroot,
    });
    return;
  }
  // extend tip
  if (h.height === lc.bestHeight + 1) {
    if (h.prevHash !== lc.bestHash) {
      throw new Error(
        `extend tip link break: prev ${h.prevHash.slice(0, 12)} != tip ${lc.bestHash.slice(0, 12)}`,
      );
    }
    lc.bestHeight = h.height;
    lc.bestHash = h.hash;
    lc.byHeight.set(h.height, {
      hash: h.hash,
      prevHash: h.prevHash,
      merkleroot: h.merkleroot,
    });
    return;
  }
  // fill gap only if parent present
  const parent = lc.byHeight.get(h.height - 1);
  if (parent) {
    if (h.prevHash !== parent.hash) {
      throw new Error(`gap fill link break at ${h.height}`);
    }
    lc.byHeight.set(h.height, {
      hash: h.hash,
      prevHash: h.prevHash,
      merkleroot: h.merkleroot,
    });
    if (h.height > lc.bestHeight) {
      lc.bestHeight = h.height;
      lc.bestHash = h.hash;
    }
    return;
  }
  throw new Error(
    `cannot apply header h=${h.height} (tip=${lc.bestHeight}); provide contiguous chain`,
  );
}

function _trim(lc) {
  if (lc.byHeight.size <= lc.maxHeaders) return;
  const heights = [...lc.byHeight.keys()].sort((a, b) => a - b);
  const drop = heights.length - lc.maxHeaders;
  for (let i = 0; i < drop; i++) {
    // never drop checkpoint
    if (heights[i] === lc.checkpointHeight) continue;
    lc.byHeight.delete(heights[i]);
  }
}

/**
 * Verify deposit claim and return credit { amountE8, txKey, blockHeight, toAccountId }.
 * Does not mutate LC unless claim.headers provided (then applyHeaders first).
 */
function verifyDepositClaim(claim, lc, opts = {}) {
  if (!claim || typeof claim !== "object") throw new Error("claim required");
  if (claim.type && claim.type !== "wart_deposit_claim") {
    throw new Error(`unexpected type ${claim.type}`);
  }

  // Optional header window for LC
  if (Array.isArray(claim.headers) && claim.headers.length > 0) {
    applyHeaders(lc, claim.headers, {
      bootstrap: !!claim.bootstrap || !lc.bootstrapped,
      pinHeight: claim.pinHeight ?? claim.finality?.pinHeight,
      pinHash: claim.pinHash ?? claim.finality?.pinHash,
    });
  }

  if (!lc.bootstrapped) {
    throw new Error("light client not bootstrapped — submit wart_headers first");
  }

  // Full PoW on deposit block only (chain headers were link-checked above)
  const header = verifyHeader(claim.header || claim.blockHeader || {}, {
    requirePow: true,
  });
  const height = Number(claim.blockHeight ?? claim.height);
  if (!Number.isFinite(height) || height < 1) {
    throw new Error("blockHeight required");
  }

  // Header must match LC store or extend via claim.headers already applied
  const stored = lc.byHeight.get(height);
  if (stored) {
    if (stored.hash !== header.hash) {
      throw new Error(`block header hash != LC at height ${height}`);
    }
  } else {
    // allow if within finality of tip and prev links to known parent
    const parent = lc.byHeight.get(height - 1);
    if (!parent || parent.hash !== header.prevHash) {
      throw new Error(
        `block h=${height} not in LC and cannot link (provide headers window)`,
      );
    }
    // adopt
    lc.byHeight.set(height, {
      hash: header.hash,
      prevHash: header.prevHash,
      merkleroot: header.merkleroot,
    });
    if (height > lc.bestHeight) {
      lc.bestHeight = height;
      lc.bestHash = header.hash;
    }
  }

  const bodyHex = claim.bodyBytes || claim.body?.bytes;
  const structure = claim.bodyStructure || claim.body?.structure;
  if (!bodyHex || !structure) {
    throw new Error("bodyBytes + bodyStructure required");
  }
  verifyBodyMerkle(bodyHex, structure, header.merkleroot);

  const poolAccountId = Number(
    claim.poolAccountId ?? opts.poolAccountId ?? lc.poolAccountId,
  );
  const deposits = findPoolDeposits(bodyHex, structure, poolAccountId);
  if (deposits.length === 0) {
    throw new Error(`no wartTransfer to pool accountId=${poolAccountId}`);
  }

  // Select transfer: by amount+optional origin, or first
  let chosen = deposits[0];
  if (claim.amountE8 != null) {
    const want = String(claim.amountE8);
    const m = deposits.find((d) => d.amountE8 === want);
    if (!m) throw new Error(`no deposit with amountE8=${want}`);
    chosen = m;
  }
  if (claim.tx?.amountE8 != null) {
    const want = String(claim.tx.amountE8);
    const m = deposits.find((d) => d.amountE8 === want);
    if (m) chosen = m;
  }

  // Finality
  const minConf = Number(
    claim.minConfirmations ?? lc.minConfirmations ?? opts.minConfirmations ?? 1,
  );
  const confs = lc.bestHeight - height;
  let final = confs >= minConf;
  const pinH = claim.finality?.pinHeight ?? lc.pinHeight;
  const pinHash = claim.finality?.pinHash ?? lc.pinHash;
  if (!final && pinH != null && height <= Number(pinH)) {
    // pinned depth — accept if pin recorded
    if (pinHash && lc.pinHash && hexNorm(pinHash) !== lc.pinHash) {
      throw new Error("finality pinHash mismatch");
    }
    final = true;
  }
  if (!final) {
    throw new Error(
      `not final: height=${height} tip=${lc.bestHeight} confs=${confs} need=${minConf}`,
    );
  }

  // Stable tx key for idempotency (height + offsets + amount)
  const txKey = hexNorm(
    claim.txHash ||
      claim.tx?.hash ||
      sha256(
        Buffer.from(
          `${height}:${chosen.beginOffset}:${chosen.amountE8}:${chosen.originAccountId}`,
          "utf8",
        ),
      ).toString("hex"),
  );

  return {
    ok: true,
    amountE8: chosen.amountE8,
    amountE8n: BigInt(chosen.amountE8),
    blockHeight: height,
    headerHash: header.hash,
    toAccountId: chosen.toAccountId,
    originAccountId: chosen.originAccountId,
    txKey,
    poolAccountId,
    confirmations: confs,
    scheme: "wart-deposit-claim-v0",
  };
}

function isWartSpvInput(input) {
  const t = input && typeof input === "object" ? input.type : null;
  return t === "wart_headers" || t === "wart_deposit_claim" || t === "wart_checkpoint";
}

module.exports = {
  HEADER_SIZE,
  MERKLE_LEAF_TAGS,
  sha256,
  sha256d,
  hexNorm,
  parseHeaderRaw,
  resolveJanushashBin,
  verifyHeaderPow,
  verifyHeader,
  merkleRootNew,
  collectBodyLeaves,
  verifyBodyMerkle,
  decodeWartTransfer,
  findPoolDeposits,
  verifyHeaderChainLinks,
  createLightClient,
  lcSnapshot,
  applyHeaders,
  verifyDepositClaim,
  isWartSpvInput,
};
