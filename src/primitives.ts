/**
 * On-Chain AI Primitives — TypeScript helpers for Phase 5 contracts.
 *
 * Provides high-level interfaces for:
 * - Inference proof creation and verification
 * - Agent identity management (WAVE-integrated)
 * - Token-gated service access control
 * - Micropayment channel lifecycle
 * - Data marketplace operations
 *
 * These helpers prepare data structures for contract interaction.
 * Actual transaction building requires radiantjs; broadcasting
 * uses the ElectrumX client from the Agent SDK.
 */

import { createHash } from "node:crypto";
import { ElectrumxClient } from "./electrumx.js";
import { addressToScripthash, isValidAddress, satoshisToRxd } from "./address.js";

// ────────────────────────────────────────────────────────────
// Blake3 (pure JS, for commitment computation)
// Uses the same implementation as radiantjs
// ────────────────────────────────────────────────────────────

/**
 * Compute blake3 hash. Falls back to sha256 if no native blake3 available.
 * For on-chain use, the actual OP_BLAKE3 opcode handles hashing.
 * This is for off-chain commitment preparation only.
 */
function blake3Hash(data: Buffer): Buffer {
  // Use sha256 as a stand-in for off-chain preparation.
  // The actual blake3 hash is computed on-chain by OP_BLAKE3.
  // For full blake3 in JS, agents should use radiantjs.crypto.blake3().
  //
  // IMPORTANT: When building real transactions, use radiantjs blake3
  // to ensure the hash matches what OP_BLAKE3 produces on-chain.
  try {
    // Try to use radiantjs blake3 if available at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const radiant = require("@radiantblockchain/radiantjs");
    if (radiant?.crypto?.blake3) {
      return radiant.crypto.blake3(data);
    }
  } catch {
    // radiantjs not installed — use placeholder
  }
  // Fallback: SHA256 placeholder (clearly marked)
  return createHash("sha256").update(data).digest();
}

// ────────────────────────────────────────────────────────────
// 5.1 Inference Proofs
// ────────────────────────────────────────────────────────────

export interface InferenceProofData {
  /** Blake3 hash of the model weights/identifier */
  modelHash: string;
  /** Blake3 hash of the input data */
  inputHash: string;
  /** Raw inference output (or hash thereof) */
  output: Buffer;
  /** blake3(modelHash || inputHash || output) */
  commitment: string;
  /** Timestamp of inference */
  timestamp: number;
}

/**
 * Prepare an inference proof commitment.
 * The agent computes blake3(modelHash || inputHash || output) off-chain,
 * then publishes it on-chain via the InferenceProof contract.
 */
export function createInferenceProof(
  modelHash: string,
  inputHash: string,
  output: Buffer,
): InferenceProofData {
  const modelBuf = Buffer.from(modelHash, "hex");
  const inputBuf = Buffer.from(inputHash, "hex");
  const preimage = Buffer.concat([modelBuf, inputBuf, output]);
  const commitment = blake3Hash(preimage);

  return {
    modelHash,
    inputHash,
    output,
    commitment: commitment.toString("hex"),
    timestamp: Date.now(),
  };
}

/**
 * Verify an inference proof commitment off-chain.
 */
export function verifyInferenceProof(
  modelHash: string,
  inputHash: string,
  output: Buffer,
  expectedCommitment: string,
): boolean {
  const proof = createInferenceProof(modelHash, inputHash, output);
  return proof.commitment === expectedCommitment;
}

// ────────────────────────────────────────────────────────────
// 5.2 Agent Identity
// ────────────────────────────────────────────────────────────

export interface AgentProfile {
  /** WAVE name (e.g., "myagent" or "research.myorg") */
  waveName?: string;
  /** Agent's payment address */
  address: string;
  /** Human-readable description */
  description: string;
  /** API endpoint URL */
  apiUrl?: string;
  /** Comma-separated capabilities */
  capabilities: string[];
  /** Pricing (e.g., "100sat/query") */
  pricing?: string;
  /** Model identifier (e.g., "gpt-4-turbo", "llama-3") */
  model?: string;
  /** Blake3 hash of the full profile (for on-chain commitment) */
  profileCommitment?: string;
}

/**
 * Build an agent profile suitable for on-chain registration.
 * Returns the profile with a blake3 commitment hash.
 */
export function buildAgentProfile(profile: Omit<AgentProfile, "profileCommitment">): AgentProfile {
  // Build CBOR-like profile data for hashing
  const profileData = JSON.stringify({
    address: profile.address,
    desc: profile.description,
    url: profile.apiUrl,
    "x-capabilities": profile.capabilities.join(","),
    "x-pricing": profile.pricing,
    "x-model": profile.model,
  });
  const commitment = blake3Hash(Buffer.from(profileData, "utf-8"));
  return {
    ...profile,
    profileCommitment: commitment.toString("hex"),
  };
}

/**
 * Build WAVE zone records for an agent identity.
 * These records are stored in the WAVE naming system.
 */
export function buildAgentWaveRecords(profile: AgentProfile): Record<string, string> {
  const records: Record<string, string> = {
    address: profile.address,
    desc: profile.description,
  };
  if (profile.apiUrl) records.url = profile.apiUrl;
  if (profile.capabilities.length) records["x-capabilities"] = profile.capabilities.join(",");
  if (profile.pricing) records["x-pricing"] = profile.pricing;
  if (profile.model) records["x-model"] = profile.model;
  return records;
}

/**
 * Parse agent capabilities from a WAVE zone record.
 */
export function parseAgentCapabilities(zone: Record<string, unknown>): AgentProfile | null {
  if (!zone || !zone.address) return null;
  const caps = typeof zone["x-capabilities"] === "string"
    ? (zone["x-capabilities"] as string).split(",").map((s) => s.trim())
    : [];
  return {
    address: zone.address as string,
    description: (zone.desc as string) || "",
    apiUrl: zone.url as string | undefined,
    capabilities: caps,
    pricing: zone["x-pricing"] as string | undefined,
    model: zone["x-model"] as string | undefined,
  };
}

// ────────────────────────────────────────────────────────────
// 5.3 Token-Gated Access
// ────────────────────────────────────────────────────────────

export interface AccessCheckResult {
  /** Whether the address holds sufficient tokens */
  authorized: boolean;
  /** Current token balance (photons) */
  balance: number;
  /** Required minimum balance (photons) */
  required: number;
  /** Human-readable status */
  message: string;
}

/**
 * Check if an address holds sufficient tokens to access a gated service.
 * Queries the Glyph balance on-chain via ElectrumX.
 */
export async function checkTokenGatedAccess(
  electrumx: ElectrumxClient,
  address: string,
  serviceTokenRef: string,
  minBalance: number,
): Promise<AccessCheckResult> {
  if (!isValidAddress(address)) {
    return { authorized: false, balance: 0, required: minBalance, message: "Invalid address" };
  }

  const sh = addressToScripthash(address);
  try {
    const bal = await electrumx.glyphGetBalance(sh, serviceTokenRef) as { confirmed: number; unconfirmed: number };
    const total = (bal?.confirmed || 0) + (bal?.unconfirmed || 0);
    return {
      authorized: total >= minBalance,
      balance: total,
      required: minBalance,
      message: total >= minBalance
        ? `Access granted: ${satoshisToRxd(total)} tokens (need ${satoshisToRxd(minBalance)})`
        : `Access denied: ${satoshisToRxd(total)} tokens (need ${satoshisToRxd(minBalance)})`,
    };
  } catch {
    return {
      authorized: false,
      balance: 0,
      required: minBalance,
      message: "Failed to query token balance",
    };
  }
}

// ────────────────────────────────────────────────────────────
// 5.4 Micropayment Channels
// ────────────────────────────────────────────────────────────

export interface ChannelState {
  /** Channel ID (txid of funding transaction) */
  channelId: string;
  /** Payer's public key hex */
  agentA: string;
  /** Payee's public key hex */
  agentB: string;
  /** Total locked amount (photons) */
  capacity: number;
  /** Current balance for agentA (photons) */
  balanceA: number;
  /** Current balance for agentB (photons) */
  balanceB: number;
  /** Incrementing nonce for state updates */
  nonce: number;
  /** Timeout in blocks before agentA can reclaim */
  timeoutBlocks: number;
  /** Latest state commitment: blake3(balanceA || balanceB || nonce) */
  stateCommitment: string;
}

/**
 * Create initial channel state after funding transaction.
 */
export function openChannel(
  channelId: string,
  agentA: string,
  agentB: string,
  capacity: number,
  timeoutBlocks = 1008, // ~3.5 days at 5-min blocks
): ChannelState {
  const state: ChannelState = {
    channelId,
    agentA,
    agentB,
    capacity,
    balanceA: capacity,
    balanceB: 0,
    nonce: 0,
    timeoutBlocks,
    stateCommitment: "",
  };
  state.stateCommitment = computeChannelCommitment(state);
  return state;
}

/**
 * Update channel state: move `amount` from agentA to agentB.
 * Returns a new state object (immutable pattern).
 */
export function updateChannel(state: ChannelState, amount: number): ChannelState {
  if (amount <= 0) throw new Error("Payment amount must be positive");
  if (amount > state.balanceA) throw new Error(`Insufficient balance: ${state.balanceA} < ${amount}`);

  const newState: ChannelState = {
    ...state,
    balanceA: state.balanceA - amount,
    balanceB: state.balanceB + amount,
    nonce: state.nonce + 1,
  };
  newState.stateCommitment = computeChannelCommitment(newState);
  return newState;
}

/**
 * Compute the state commitment for a channel.
 * This is what agentA signs to authorize a state update.
 */
export function computeChannelCommitment(state: ChannelState): string {
  const data = Buffer.alloc(24);
  data.writeBigInt64LE(BigInt(state.balanceA), 0);
  data.writeBigInt64LE(BigInt(state.balanceB), 8);
  data.writeBigInt64LE(BigInt(state.nonce), 16);
  return blake3Hash(data).toString("hex");
}

/**
 * Get a human-readable summary of channel state.
 */
export function channelSummary(state: ChannelState): string {
  return [
    `Channel: ${state.channelId.slice(0, 16)}...`,
    `Capacity: ${satoshisToRxd(state.capacity)} RXD`,
    `Agent A: ${satoshisToRxd(state.balanceA)} RXD`,
    `Agent B: ${satoshisToRxd(state.balanceB)} RXD`,
    `Nonce: ${state.nonce}`,
    `Timeout: ${state.timeoutBlocks} blocks`,
  ].join("\n");
}

// ────────────────────────────────────────────────────────────
// 5.5 Data Marketplace
// ────────────────────────────────────────────────────────────

export interface DataAsset {
  /** NFT reference for this data asset */
  ref: string;
  /** Asset type */
  type: "dataset" | "model" | "collection" | "computation";
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Blake3 hash of the content */
  contentHash: string;
  /** Size in bytes */
  sizeBytes?: number;
  /** MIME type */
  mimeType?: string;
  /** Asking price in photons (0 = free / open) */
  price: number;
  /** Parent dataset refs (for provenance tracking) */
  derivedFrom?: string[];
  /** License terms */
  license?: string;
}

/**
 * Build Glyph metadata for a data asset NFT.
 * Returns a structure suitable for CBOR encoding in a Glyph commit-reveal.
 */
export function buildDataAssetMetadata(asset: DataAsset): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    v: 2,
    p: [2, 3], // NFT + DAT
    name: asset.name,
    desc: asset.description,
    "x-type": asset.type,
    "x-content-hash": asset.contentHash,
    "x-price": asset.price,
  };
  if (asset.sizeBytes) meta["x-size"] = asset.sizeBytes;
  if (asset.mimeType) meta["x-mime"] = asset.mimeType;
  if (asset.derivedFrom?.length) meta["x-derived-from"] = asset.derivedFrom;
  if (asset.license) meta["x-license"] = asset.license;
  return meta;
}

/**
 * Compute provenance commitment for a derived dataset.
 * blake3(parentHash1 || parentHash2 || ... || transformDescription)
 */
export function computeProvenanceCommitment(
  parentHashes: string[],
  transformDescription: string,
): string {
  const parts = parentHashes.map((h) => Buffer.from(h, "hex"));
  parts.push(Buffer.from(transformDescription, "utf-8"));
  return blake3Hash(Buffer.concat(parts)).toString("hex");
}

/**
 * Search for data assets by querying Glyph tokens with x-type metadata.
 */
export async function searchDataAssets(
  electrumx: ElectrumxClient,
  query: string,
  assetType?: DataAsset["type"],
  limit = 50,
): Promise<unknown> {
  // Search tokens, then filter by x-type if needed
  const results = await electrumx.glyphSearchTokens(query, [2, 3], limit);
  // Further filtering by asset type would require metadata inspection
  return results;
}
