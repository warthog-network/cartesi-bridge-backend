# Native Warthog vault model (spendable + dApp lock)

## What you want

```text
main mnemonic + secret + sub index
        │
        ▼
  Warthog vault keypair  ──funds──►  real WART held as collateral
        │
        ▼
  Cartesi dApp locks policy while spoofed wWART is outstanding
        │
        ▼
  burn / return spoofed wWART  →  unlock notice  →  owner withdraws with vault key
```

Yes — this is the right model for “borrow wWART against locked WART”.

## What was wrong before

`zk-proof-generator` only did:

```text
address = hash(sub_address || index)  →  looks like a Warthog address
```

That is **not** a secp256k1 public-key address. Sweeping real WART there made funds **unrecoverable**.

## Current design

| Piece | Responsibility |
|-------|----------------|
| **Frontend** `vaultDerive.js` | `secret = SHA256("bridge-secret-v1"\|\|mnemonic)`; `priv = f(secret, sub, index)`; Warthog address |
| **Rust** `zk-proof-generator` | Same formula with `--secret` (host recovery + cartesi build binary) |
| **Cartesi dApp** | Stores **public** `vaultAddress` + lock/mint/burn state; **never** sees mnemonic/secret |
| **sub_lock / create_vault** | Prefer client `vaultAddress`; fallback legacy commitment only if missing |
| **sweep_lock** | Prove WART moved sub → vault; mint spoofed wWART 1:1; mark locked |
| **sub_unlock** | After burn amount of spoofed wWART; emit unlock; owner may spend vault key |

### Domain separation (must match FE ↔ Rust)

```text
DOMAIN = "cartesi-bridge-wart-vault-v1"
material = SHA256( DOMAIN || 0x00 || secret_bytes || 0x00 || sub_hex || 0x00 || index_decimal )
private_key = material as secp256k1 scalar (rehash if invalid)
address = RIPEMD160(SHA256(compressed_pubkey)) || SHA256(ripe)[0..4]
```

## Cargo (host)

```bash
cd cartesi-bridge-backend
cargo build --release --bin zk-proof-generator

# Recovery (offline — keep --show-key off shared logs)
./target/release/zk-proof-generator \
  --sub-address <48hex-sub> \
  --index <n> \
  --secret <hex-from-bridgeSecretFromMnemonic> \
  --show-key
```

## Cartesi image

Dockerfile already:

1. Cross-compiles `zk-proof-generator` for `riscv64`
2. Installs to `/opt/cartesi/bin/zk-proof-generator`
3. dApp resolves bin via `ZK_PROOF_GENERATOR` env or that path / host `target/release`

Rebuild machine after Rust changes:

```bash
cd cartesi-bridge-backend
cargo build --release --bin zk-proof-generator   # host test
cartesi build                                   # riscv64 image
```

## Security notes

- **Never** put mnemonic or vault private key in advance inputs.
- Publishing `vaultAddress` on-chain is fine (public receive address).
- Anyone who learns `secret` + sub + index can spend the vault — treat mnemonic backup as full control of vaults too.
- Legacy locks without client `vaultAddress` remain non-spendable commitments; migrate by creating new secret-derived vaults.

## End-to-end flow (product)

1. Derive vault (client) + optional `create_vault` / auto on `sub_lock` with `vaultAddress`
2. Main → sub WART; `sub_lock` proof
3. Sub → vault WART; `sweep_lock` → mint spoofed wWART; **locked**
4. `sub_unlock` / burn spoofed wWART → debit rollup wWART; **unlocked** when fully burned
5. UI **Withdraw vault → main** re-derives vault key and transfers native WART

Policy lock is enforced in the app/rollup accounting. Native Warthog cannot freeze an address without a covenant; the spendable key is always with the mnemonic owner after they choose to spend.
