/**
 * BIP39 mnemonic generation/validation + BIP32 HD key derivation.
 * Uses Node.js crypto only — no external dependencies.
 *
 * Supports 12/15/18/21/24-word mnemonics.
 * Default derivation path: m/44'/0'/0'/0/index (BIP44, coin type 0)
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { ENGLISH_WORDLIST } from "./bip39-wordlist.js";

// ────────────────────────────────────────────────────────────
// BIP39: Mnemonic ↔ Entropy
// ────────────────────────────────────────────────────────────

const STRENGTH_MAP: Record<number, number> = {
  12: 128, 15: 160, 18: 192, 21: 224, 24: 256,
};

/**
 * Generate a BIP39 mnemonic phrase.
 * @param wordCount 12, 15, 18, 21, or 24 (default 12)
 */
export function generateMnemonic(wordCount: 12 | 15 | 18 | 21 | 24 = 12): string {
  const strength = STRENGTH_MAP[wordCount];
  if (!strength) throw new Error(`Invalid word count: ${wordCount}`);

  const entropy = randomBytes(strength / 8);
  const hash = createHash("sha256").update(entropy).digest();
  const checksumBits = strength / 32;

  // Convert entropy + checksum to bit string
  let bits = "";
  for (const byte of entropy) bits += byte.toString(2).padStart(8, "0");
  for (let i = 0; i < checksumBits; i++) bits += ((hash[0] >> (7 - i)) & 1).toString();

  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    const idx = parseInt(bits.slice(i, i + 11), 2);
    words.push(ENGLISH_WORDLIST[idx]);
  }

  return words.join(" ");
}

/**
 * Validate a BIP39 mnemonic phrase (checksum verification).
 */
export function validateMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (!(words.length in STRENGTH_MAP)) return false;

  // Convert words to indices
  const indices: number[] = [];
  for (const word of words) {
    const idx = ENGLISH_WORDLIST.indexOf(word);
    if (idx < 0) return false;
    indices.push(idx);
  }

  // Convert to bit string
  let bits = "";
  for (const idx of indices) bits += idx.toString(2).padStart(11, "0");

  const entropyBits = (words.length * 11 * 32) / 33;
  const checksumBits = bits.length - entropyBits;
  const entropyBytes = Buffer.alloc(entropyBits / 8);
  for (let i = 0; i < entropyBits / 8; i++) {
    entropyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  // Verify checksum
  const hash = createHash("sha256").update(entropyBytes).digest();
  let checksumActual = "";
  for (let i = 0; i < checksumBits; i++) checksumActual += ((hash[0] >> (7 - i)) & 1).toString();

  return bits.slice(entropyBits) === checksumActual;
}

/**
 * Convert a BIP39 mnemonic to a 64-byte seed (PBKDF2-SHA512).
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ""): Buffer {
  const mnemonicNorm = mnemonic.trim().normalize("NFKD");
  const salt = ("mnemonic" + passphrase).normalize("NFKD");
  return pbkdf2Sync(mnemonicNorm, salt, 2048, 64, "sha512");
}

// ────────────────────────────────────────────────────────────
// BIP32: HD Key Derivation
// ────────────────────────────────────────────────────────────

interface HDKey {
  privateKey: Buffer;
  chainCode: Buffer;
}

const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

function hmacSha512(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha512", key).update(data).digest();
}

/**
 * Derive BIP32 master key from seed.
 */
function masterKeyFromSeed(seed: Buffer): HDKey {
  const I = hmacSha512(Buffer.from("Bitcoin seed"), seed);
  const privateKey = I.subarray(0, 32);
  const chainCode = I.subarray(32);

  const k = BigInt("0x" + privateKey.toString("hex"));
  if (k === 0n || k >= SECP256K1_N) throw new Error("Invalid master key (astronomically unlikely)");

  return { privateKey: Buffer.from(privateKey), chainCode: Buffer.from(chainCode) };
}

// Minimal secp256k1 pubkey derivation (compressed)
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;

function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [((a % m) + m) % m, m];
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
    : ((y2 - y1 + P) % P) * modInv((x2 - x1 + P) % P, P) % P;
  const x3 = ((s * s - x1 - x2) % P + P) % P;
  const y3 = ((s * ((x1 - x3 + P) % P) - y1) % P + P) % P;
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

function compressedPubKey(privKey: Buffer): Buffer {
  const k = BigInt("0x" + privKey.toString("hex"));
  const [x, y] = ecMul(k, GX, GY);
  const prefix = y % 2n === 0n ? 0x02 : 0x03;
  return Buffer.from([prefix, ...Buffer.from(x.toString(16).padStart(64, "0"), "hex")]);
}

/**
 * Derive a child key (hardened or normal).
 */
function deriveChild(parent: HDKey, index: number): HDKey {
  const hardened = index >= 0x80000000;
  let data: Buffer;

  if (hardened) {
    // Hardened: 0x00 || privateKey || index
    data = Buffer.alloc(37);
    data[0] = 0x00;
    parent.privateKey.copy(data, 1);
    data.writeUInt32BE(index, 33);
  } else {
    // Normal: compressedPubKey || index
    const pubKey = compressedPubKey(parent.privateKey);
    data = Buffer.alloc(37);
    pubKey.copy(data, 0);
    data.writeUInt32BE(index, 33);
  }

  const I = hmacSha512(parent.chainCode, data);
  const il = BigInt("0x" + I.subarray(0, 32).toString("hex"));
  const kPar = BigInt("0x" + parent.privateKey.toString("hex"));
  const kChild = (il + kPar) % SECP256K1_N;

  if (il >= SECP256K1_N || kChild === 0n) {
    throw new Error("Invalid child key (astronomically unlikely)");
  }

  const childKey = Buffer.from(kChild.toString(16).padStart(64, "0"), "hex");
  const chainCode = Buffer.from(I.subarray(32));

  return { privateKey: childKey, chainCode };
}

/**
 * Derive a private key from a path like "m/44'/0'/0'/0/0".
 */
function derivePath(seed: Buffer, path: string): Buffer {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("Path must start with 'm'");

  let key = masterKeyFromSeed(seed);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const hardened = part.endsWith("'");
    const index = parseInt(hardened ? part.slice(0, -1) : part, 10);
    if (isNaN(index)) throw new Error(`Invalid path segment: ${part}`);
    key = deriveChild(key, hardened ? index + 0x80000000 : index);
  }

  return key.privateKey;
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export interface MnemonicResult {
  mnemonic: string;
  seed: string;
  privateKey: string;
  path: string;
}

/**
 * Generate a new mnemonic and derive the private key at the given path.
 * Default path: m/44'/0'/0'/0/0 (first BIP44 address, Bitcoin/Radiant compatible)
 */
export function generateWalletFromMnemonic(
  wordCount: 12 | 15 | 18 | 21 | 24 = 12,
  passphrase = "",
  path = "m/44'/0'/0'/0/0",
): MnemonicResult {
  const mnemonic = generateMnemonic(wordCount);
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const privateKey = derivePath(seed, path);
  return {
    mnemonic,
    seed: seed.toString("hex"),
    privateKey: privateKey.toString("hex"),
    path,
  };
}

/**
 * Restore a private key from an existing mnemonic at the given derivation path.
 */
export function restoreFromMnemonic(
  mnemonic: string,
  passphrase = "",
  path = "m/44'/0'/0'/0/0",
): MnemonicResult {
  if (!validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic");
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const privateKey = derivePath(seed, path);
  return {
    mnemonic: mnemonic.trim().toLowerCase(),
    seed: seed.toString("hex"),
    privateKey: privateKey.toString("hex"),
    path,
  };
}
