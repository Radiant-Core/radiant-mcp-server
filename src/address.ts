import { createHash } from "node:crypto";

/**
 * Convert a Radiant address to an ElectrumX scripthash.
 * 
 * ElectrumX indexes by scripthash = SHA256(scriptPubKey) reversed.
 * For P2PKH: scriptPubKey = OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Buffer {
  let num = BigInt(0);
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  // Count leading '1's (each represents a 0x00 byte)
  let leadingZeros = 0;
  for (const char of str) {
    if (char === "1") leadingZeros++;
    else break;
  }

  // Convert bigint to hex, ensure even length
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const payload = Buffer.from(hex, "hex");

  return Buffer.concat([Buffer.alloc(leadingZeros), payload]);
}

/**
 * Decode a base58check-encoded Radiant address and return the 20-byte pubkey hash.
 * Radiant mainnet P2PKH prefix: 0x00
 * Radiant mainnet P2SH prefix: 0x05
 */
function decodeAddress(address: string): { version: number; hash: Buffer } {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(`Invalid address length: ${decoded.length} (expected 25)`);
  }

  // Verify checksum (last 4 bytes)
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  const hash = createHash("sha256").update(
    createHash("sha256").update(payload).digest(),
  ).digest();

  if (!hash.subarray(0, 4).equals(checksum)) {
    throw new Error("Invalid address checksum");
  }

  return {
    version: decoded[0],
    hash: decoded.subarray(1, 21),
  };
}

/**
 * Build the scriptPubKey for a given address.
 */
function buildScriptPubKey(address: string): Buffer {
  const { version, hash } = decodeAddress(address);

  if (version === 0x00) {
    // P2PKH: OP_DUP OP_HASH160 <20> <hash> OP_EQUALVERIFY OP_CHECKSIG
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      hash,
      Buffer.from([0x88, 0xac]),
    ]);
  } else if (version === 0x05) {
    // P2SH: OP_HASH160 <20> <hash> OP_EQUAL
    return Buffer.concat([
      Buffer.from([0xa9, 0x14]),
      hash,
      Buffer.from([0x87]),
    ]);
  } else {
    throw new Error(`Unsupported address version: 0x${version.toString(16)}`);
  }
}

/**
 * Convert a Radiant address to an ElectrumX scripthash.
 * scripthash = SHA256(scriptPubKey), byte-reversed, as hex.
 */
export function addressToScripthash(address: string): string {
  const script = buildScriptPubKey(address);
  const hash = createHash("sha256").update(script).digest();
  // Reverse for ElectrumX
  return Buffer.from(hash).reverse().toString("hex");
}

/**
 * Validate that a string looks like a valid Radiant address.
 */
export function isValidAddress(address: string): boolean {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format satoshi amounts to RXD (8 decimal places).
 */
export function satoshisToRxd(satoshis: number): string {
  const rxd = satoshis / 1e8;
  return rxd.toFixed(8);
}

/**
 * Convert RXD to satoshis.
 */
export function rxdToSatoshis(rxd: number): number {
  return Math.round(rxd * 1e8);
}
