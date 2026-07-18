//! Warthog vault address derivation for the Cartesi ↔ Warthog bridge.
//!
//! ## Security model
//!
//! A **spendable** vault is a real secp256k1 keypair:
//!
//! ```text
//! secret_bytes  = user bridge secret (frontend: SHA256("bridge-secret-v1" || mnemonic))
//! material      = SHA256( DOMAIN || 0x00 || secret || 0x00 || sub_hex || 0x00 || index_str )
//! private_key   = material as 32-byte scalar (rehash while ≥ curve order)
//! address       = RIPEMD160(SHA256(compressed_pubkey)) || SHA256(ripe)[0..4]   // 48 hex
//! ```
//!
//! - The **user mnemonic / secret never goes on-chain**. Frontend derives the key offline.
//! - The Cartesi machine stores only the **public vault address** and lock policy.
//! - While locked (spoofed wWART outstanding), dApp treats vault as collateral —
//!   unlock notice only after burn/return of spoofed wWART; then user spends with derived key.
//!
//! Host recovery (offline, with secret):
//! ```bash
//! cargo build --release --bin zk-proof-generator
//! ./target/release/zk-proof-generator \
//!   --sub-address <48hex> --index <n> --secret <hex-or-utf8> [--show-key]
//! ```
//!
//! Legacy (no --secret): commitment hash only — **not spendable**. Prefer --secret always.

use hex;
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::PublicKey;
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};
use std::env;
use std::process;

const DOMAIN: &[u8] = b"cartesi-bridge-wart-vault-v1";

fn usage() {
    eprintln!(
        "Usage:
  zk-proof-generator --sub-address <hex> --index <u32> --secret <hex|utf8> [--show-key]
  zk-proof-generator --sub-address <hex> --index <u32>   # legacy non-spendable commitment

Prints: 0x<48-hex-warthog-address>
With --show-key also prints: PRIVKEY <64-hex>  (host recovery only — never log on rollup)"
    );
}

fn parse_args(args: &[String]) -> (String, u32, Option<String>, bool) {
    let mut sub_address = String::new();
    let mut index: u32 = 0;
    let mut secret: Option<String> = None;
    let mut show_key = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--sub-address" => {
                if i + 1 >= args.len() {
                    eprintln!("Error: --sub-address requires a value");
                    process::exit(2);
                }
                sub_address = args[i + 1].trim().trim_start_matches("0x").to_lowercase();
                i += 2;
            }
            "--index" => {
                if i + 1 >= args.len() {
                    eprintln!("Error: --index requires a value");
                    process::exit(2);
                }
                index = args[i + 1].parse().unwrap_or_else(|_| {
                    eprintln!("Error: invalid --index");
                    process::exit(2);
                });
                i += 2;
            }
            "--secret" => {
                if i + 1 >= args.len() {
                    eprintln!("Error: --secret requires a value");
                    process::exit(2);
                }
                secret = Some(args[i + 1].clone());
                i += 2;
            }
            "--show-key" => {
                show_key = true;
                i += 1;
            }
            "-h" | "--help" => {
                usage();
                process::exit(0);
            }
            other => {
                eprintln!("Unknown arg: {other}");
                usage();
                process::exit(2);
            }
        }
    }

    if sub_address.is_empty() {
        eprintln!("Error: --sub-address is required");
        usage();
        process::exit(2);
    }
    if !(sub_address.len() == 40 || sub_address.len() == 48)
        || !sub_address.chars().all(|c| c.is_ascii_hexdigit())
    {
        eprintln!("Error: --sub-address must be 40 or 48 hex chars");
        process::exit(2);
    }

    (sub_address, index, secret, show_key)
}

/// Domain-separated SHA256 material for vault private key.
fn vault_material(secret: &[u8], sub_address_hex: &str, index: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN);
    h.update([0u8]);
    h.update(secret);
    h.update([0u8]);
    h.update(sub_address_hex.as_bytes());
    h.update([0u8]);
    h.update(index.to_string().as_bytes());
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn secret_bytes(secret_arg: &str) -> Vec<u8> {
    let s = secret_arg.trim();
    let hexish = s.trim_start_matches("0x");
    if hexish.len() >= 32
        && hexish.len() % 2 == 0
        && hexish.chars().all(|c| c.is_ascii_hexdigit())
    {
        hex::decode(hexish).unwrap_or_else(|_| s.as_bytes().to_vec())
    } else {
        s.as_bytes().to_vec()
    }
}

/// Reduce 32-byte hash to a valid secp256k1 signing key.
fn material_to_signing_key(mut material: [u8; 32]) -> SigningKey {
    // If invalid (0 or ≥ n), rehash until valid — same approach as many deterministic wallets.
    loop {
        if let Ok(sk) = SigningKey::from_slice(&material) {
            return sk;
        }
        let mut h = Sha256::new();
        h.update(b"cartesi-bridge-wart-vault-v1-retry");
        h.update(material);
        let out = h.finalize();
        material.copy_from_slice(&out);
    }
}

fn warthog_address_from_pubkey(pubkey: &PublicKey) -> String {
    let point = pubkey.to_encoded_point(true); // compressed
    let compressed = point.as_bytes();

    let mut sha = Sha256::new();
    sha.update(compressed);
    let sha_out = sha.finalize();

    let mut ripe = Ripemd160::new();
    ripe.update(&sha_out);
    let ripe_out = ripe.finalize();

    let mut chk = Sha256::new();
    chk.update(&ripe_out);
    let chk_full = chk.finalize();

    format!("{}{}", hex::encode(ripe_out), hex::encode(&chk_full[0..4]))
}

/// Legacy non-spendable commitment (pre-v1). Kept for machine fallback only.
fn legacy_commitment_address(sub_address: &str, index: u32) -> String {
    let input = format!("{sub_address}{index}");
    let mut sha = Sha256::new();
    sha.update(input.as_bytes());
    let sha_out = sha.finalize();

    let mut ripe = Ripemd160::new();
    ripe.update(&sha_out);
    let ripe_out = ripe.finalize();

    let mut chk = Sha256::new();
    chk.update(&ripe_out);
    let chk_full = chk.finalize();

    format!("{}{}", hex::encode(ripe_out), hex::encode(&chk_full[0..4]))
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let (sub_address, index, secret_opt, show_key) = parse_args(&args);

    if let Some(secret_arg) = secret_opt {
        let sec = secret_bytes(&secret_arg);
        let material = vault_material(&sec, &sub_address, index);
        let sk = material_to_signing_key(material);
        let pk = PublicKey::from(sk.verifying_key());
        let address = warthog_address_from_pubkey(&pk);

        println!("0x{address}");
        println!(
            "ZK Proof: Spendable Warthog vault (v1) from secret+sub+index — key never leaves owner wallet."
        );
        if show_key {
            // Host recovery only. Do not enable in rollup logs.
            println!("PRIVKEY {}", hex::encode(sk.to_bytes()));
        }
    } else {
        let address = legacy_commitment_address(&sub_address, index);
        println!("0x{address}");
        println!(
            "ZK Proof: LEGACY non-spendable commitment (no --secret). Prefer secret-derived vaults."
        );
    }
}
