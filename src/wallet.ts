/**
 * Lightweight wallet management for AI agents.
 * Handles key generation, address derivation, and WIF import/export.
 * Uses Node.js crypto primitives only — no radiantjs dependency.
 *
 * For full BIP39 mnemonic support and transaction signing,
 * agents should integrate radiantjs directly.
 */

import { createHash, randomBytes } from "node:crypto";

// ────────────────────────────────────────────────────────────
// secp256k1 minimal (compressed pubkey derivation only)
// ────────────────────────────────────────────────────────────

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

function ecAdd(x1: bigint, y1: bigint, x2: bigint, y2: bigint): [bigint, bigint] {
  const s = x1 === x2 && y1 === y2
    ? (3n * x1 * x1) * modInv(2n * y1, P) % P
    : (y2 - y1) * modInv((x2 - x1 + P) % P, P) % P;
  const x3 = (s * s - x1 - x2 + 2n * P) % P;
  const y3 = (s * (x1 - x3 + P) - y1 + P) % P;
  return [x3, y3];
}

function ecMul(k: bigint, px: bigint, py: bigint): [bigint, bigint] {
  let rx = 0n, ry = 0n, first = true;
  let qx = px, qy = py;
  while (k > 0n) {
    if (k & 1n) {
      if (first) { rx = qx; ry = qy; first = false; }
      else [rx, ry] = ecAdd(rx, ry, qx, qy);
    }
    [qx, qy] = ecAdd(qx, qy, qx, qy);
    k >>= 1n;
  }
  return [rx, ry];
}

function privToPubKey(privKey: Buffer): Buffer {
  const k = BigInt("0x" + privKey.toString("hex"));
  const [x, y] = ecMul(k, GX, GY);
  const prefix = y % 2n === 0n ? 0x02 : 0x03;
  return Buffer.from([prefix, ...Buffer.from(x.toString(16).padStart(64, "0"), "hex")]);
}

// ────────────────────────────────────────────────────────────
// Address encoding
// ────────────────────────────────────────────────────────────

function hash160(data: Buffer): Buffer {
  return createHash("ripemd160").update(createHash("sha256").update(data).digest()).digest();
}

function sha256d(data: Buffer): Buffer {
  return createHash("sha256").update(createHash("sha256").update(data).digest()).digest();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(buf: Buffer): string {
  let num = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (num > 0n) { s = B58[Number(num % 58n)] + s; num /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}

function b58check(version: number, payload: Buffer): string {
  const vp = Buffer.concat([Buffer.from([version]), payload]);
  return b58encode(Buffer.concat([vp, sha256d(vp).subarray(0, 4)]));
}

function b58decode(str: string): Buffer {
  let num = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error("Bad b58"); num = num * 58n + BigInt(i); }
  let zeros = 0;
  for (const c of str) { if (c === "1") zeros++; else break; }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

// ────────────────────────────────────────────────────────────
// Wallet class
// ────────────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  publicKey: string;
  wif: string;
  network: "mainnet" | "testnet";
}

export class AgentWallet {
  private readonly privKey: Buffer;
  readonly publicKey: Buffer;
  readonly address: string;
  readonly network: "mainnet" | "testnet";

  private constructor(privKey: Buffer, network: "mainnet" | "testnet") {
    const k = BigInt("0x" + privKey.toString("hex"));
    if (k <= 0n || k >= N) throw new Error("Invalid private key");
    this.privKey = privKey;
    this.network = network;
    this.publicKey = privToPubKey(privKey);
    this.address = b58check(network === "mainnet" ? 0x00 : 0x6f, hash160(this.publicKey));
  }

  /** Create a new wallet with a random private key. */
  static create(network: "mainnet" | "testnet" = "mainnet"): AgentWallet {
    let key: Buffer;
    do { key = randomBytes(32); } while (BigInt("0x" + key.toString("hex")) <= 0n || BigInt("0x" + key.toString("hex")) >= N);
    return new AgentWallet(key, network);
  }

  /** Restore from WIF-encoded private key. */
  static fromWIF(wif: string): AgentWallet {
    const decoded = b58decode(wif);
    // Verify checksum
    const payload = decoded.subarray(0, decoded.length - 4);
    const checksum = decoded.subarray(decoded.length - 4);
    if (!sha256d(payload).subarray(0, 4).equals(checksum)) throw new Error("Invalid WIF checksum");
    const version = decoded[0];
    const network = version === 0x80 ? "mainnet" as const : "testnet" as const;
    // Remove version byte and optional compression flag
    const keyBytes = decoded[decoded.length - 5] === 0x01
      ? decoded.subarray(1, 33)  // compressed
      : decoded.subarray(1, decoded.length - 4);
    return new AgentWallet(keyBytes, network);
  }

  /** Restore from hex-encoded private key. */
  static fromHex(hex: string, network: "mainnet" | "testnet" = "mainnet"): AgentWallet {
    return new AgentWallet(Buffer.from(hex, "hex"), network);
  }

  /** Export private key as WIF. */
  getWIF(): string {
    return b58check(this.network === "mainnet" ? 0x80 : 0xef, Buffer.concat([this.privKey, Buffer.from([0x01])]));
  }

  /** Get wallet info (safe to log — WIF shown, raw key hidden). */
  getInfo(): WalletInfo {
    return {
      address: this.address,
      publicKey: this.publicKey.toString("hex"),
      wif: this.getWIF(),
      network: this.network,
    };
  }

  /** Get raw private key bytes. Use with caution. */
  getPrivateKeyBuffer(): Buffer {
    return Buffer.from(this.privKey);
  }

  /** Get compressed public key hex. */
  getPublicKeyHex(): string {
    return this.publicKey.toString("hex");
  }
}
