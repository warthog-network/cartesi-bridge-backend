/**
 * Phase 3 SPV scaffold — partial (header-link checks only; no full PoW in-machine).
 * Host-side full chain test: scripts/lib/wartSpvHost.mjs + scripts/spv-host-selftest.mjs
 * See /opt/cartesi-bridge/docs/PHASE-3-SPV-ATOMIC-DEPOSIT.md
 *
 * CommonJS so it loads from cartesi-bridge-backend/src/index.js today.
 */

const WART_SPV_INPUT_TYPES = ["wart_headers", "wart_deposit_claim"];

function isWartSpvInput(input) {
  const t = input && typeof input === "object" ? input.type : null;
  return WART_SPV_INPUT_TYPES.includes(t);
}

/**
 * Lightweight header-link check (same rules as host wartSpvHost.verifyHeaderChain).
 * headers: oldest → newest, each { hash, prevHash } hex64.
 */
function verifyHeaderChainLinks(headers) {
  if (!Array.isArray(headers) || headers.length < 1) {
    return { ok: false, reason: "empty headers" };
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i] || {};
    const hash = String(h.hash || "")
      .toLowerCase()
      .replace(/^0x/, "");
    const prevHash = String(h.prevHash || "")
      .toLowerCase()
      .replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { ok: false, reason: `bad hash at i=${i}` };
    }
    if (!/^[0-9a-f]{64}$/.test(prevHash)) {
      return { ok: false, reason: `bad prevHash at i=${i}` };
    }
    if (i > 0) {
      const prev = String(headers[i - 1].hash || "")
        .toLowerCase()
        .replace(/^0x/, "");
      if (prevHash !== prev) {
        return {
          ok: false,
          reason: `link break at i=${i}`,
        };
      }
    }
  }
  return {
    ok: true,
    tip: String(headers[headers.length - 1].hash)
      .toLowerCase()
      .replace(/^0x/, ""),
    length: headers.length,
  };
}

/**
 * Placeholder deposit claim — still rejects full credit until merkle/PoW land.
 * Accepts optional header window pre-check when claim.headers is present.
 */
function verifyWartDepositClaim(claim, _state) {
  if (claim && Array.isArray(claim.headers) && claim.headers.length > 0) {
    const link = verifyHeaderChainLinks(claim.headers);
    if (!link.ok) {
      throw new Error(`wart_deposit_claim header chain: ${link.reason}`);
    }
  }
  throw new Error(
    "wart_deposit_claim SPV not implemented — use pool_deposit + host relayer (header links OK if provided)",
  );
}

module.exports = {
  WART_SPV_INPUT_TYPES,
  isWartSpvInput,
  verifyHeaderChainLinks,
  verifyWartDepositClaim,
};
