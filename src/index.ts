#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ElectrumxClient } from "./electrumx.js";
import { addressToScripthash, isValidAddress, satoshisToRxd } from "./address.js";
import {
  getChainOverview,
  getOpcodeReference,
  getProtocolReference,
  GLYPH_PROTOCOLS,
  DMINT_ALGORITHMS,
  NETWORK_PARAMS,
} from "./references.js";
import {
  createInferenceProof,
  verifyInferenceProof,
  buildAgentProfile,
  buildAgentWaveRecords,
  parseAgentCapabilities,
  checkTokenGatedAccess,
  openChannel,
  updateChannel,
  channelSummary,
  buildDataAssetMetadata,
  computeProvenanceCommitment,
  searchDataAssets,
} from "./primitives.js";
import type { DataAsset } from "./primitives.js";

// ────────────────────────────────────────────────────────────
// Configuration from environment
// ────────────────────────────────────────────────────────────

const ELECTRUMX_HOST = process.env.ELECTRUMX_HOST || "electrumx.radiant4people.com";
const ELECTRUMX_PORT = parseInt(process.env.ELECTRUMX_PORT || "50012", 10);
const ELECTRUMX_SSL = (process.env.ELECTRUMX_SSL || "true") !== "false";
const NETWORK = (process.env.RADIANT_NETWORK || "mainnet") as "mainnet" | "testnet";

// ────────────────────────────────────────────────────────────
// ElectrumX client (lazy-connected)
// ────────────────────────────────────────────────────────────

const electrumx = new ElectrumxClient({
  host: ELECTRUMX_HOST,
  port: ELECTRUMX_PORT,
  ssl: ELECTRUMX_SSL,
  timeout: 30_000,
});

async function ensureConnected(): Promise<void> {
  if (!electrumx.isConnected()) {
    try {
      await electrumx.connect();
      await electrumx.serverVersion("radiant-mcp-server/1.0.0", "1.4");
    } catch (err) {
      throw new Error(`ElectrumX connection failed (${ELECTRUMX_HOST}:${ELECTRUMX_PORT}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Classify errors for structured reporting. */
function classifyError(err: unknown): { code: string; message: string; retryable: boolean } {
  const msg = errorText(err);
  if (msg.includes("timeout")) return { code: "TIMEOUT", message: msg, retryable: true };
  if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")) return { code: "CONNECTION_ERROR", message: msg, retryable: true };
  if (msg.includes("connection failed")) return { code: "CONNECTION_ERROR", message: msg, retryable: true };
  if (msg.includes("Invalid") || msg.includes("invalid")) return { code: "INVALID_INPUT", message: msg, retryable: false };
  if (msg.includes("not found") || msg.includes("Not found")) return { code: "NOT_FOUND", message: msg, retryable: false };
  return { code: "INTERNAL_ERROR", message: msg, retryable: false };
}

function errorResponse(err: unknown) {
  const classified = classifyError(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: classified.code, message: classified.message, retryable: classified.retryable }) }],
    isError: true,
  };
}

function jsonText(data: unknown) {
  return { type: "text" as const, text: JSON.stringify(data, null, 2) };
}

// ────────────────────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "radiant-mcp-server",
  version: "1.4.0",
});

// ════════════════════════════════════════════════════════════
//  TOOLS — Blockchain
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_chain_info",
  "Get current Radiant blockchain status: latest block height, tip hash, and network parameters",
  {},
  async () => {
    try {
      await ensureConnected();
      const tip = await electrumx.headersSubscribe();
      const params = NETWORK_PARAMS[NETWORK];
      return {
        content: [jsonText({
          network: NETWORK,
          height: tip.height,
          blockHeaderHex: tip.hex,
          ticker: params.ticker,
          miningAlgorithm: params.miningAlgorithm,
          blockTime: `${params.blockTime / 60} minutes`,
          maxBlockSize: `${params.maxBlockSize / 1_000_000} MB`,
          v2ActivationHeight: params.v2ActivationHeight,
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_balance",
  "Get RXD balance for a Radiant address (confirmed and unconfirmed, in both satoshis and RXD)",
  { address: z.string().describe("Radiant address (base58check encoded, starts with 1 or 3)") },
  async ({ address }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const balance = await electrumx.getBalance(scripthash);
      return {
        content: [jsonText({
          address,
          confirmed: { satoshis: balance.confirmed, rxd: satoshisToRxd(balance.confirmed) },
          unconfirmed: { satoshis: balance.unconfirmed, rxd: satoshisToRxd(balance.unconfirmed) },
          total: {
            satoshis: balance.confirmed + balance.unconfirmed,
            rxd: satoshisToRxd(balance.confirmed + balance.unconfirmed),
          },
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_utxos",
  "List unspent transaction outputs (UTXOs) for a Radiant address",
  {
    address: z.string().describe("Radiant address"),
  },
  async ({ address }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const utxos = await electrumx.listUnspent(scripthash);
      return {
        content: [jsonText({
          address,
          count: utxos.length,
          utxos: utxos.map((u) => ({
            txid: u.tx_hash,
            vout: u.tx_pos,
            height: u.height,
            value: { satoshis: u.value, rxd: satoshisToRxd(u.value) },
          })),
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_history",
  "Get transaction history for a Radiant address",
  {
    address: z.string().describe("Radiant address"),
  },
  async ({ address }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const history = await electrumx.getHistory(scripthash);
      return {
        content: [jsonText({
          address,
          count: history.length,
          transactions: history.map((h) => ({
            txid: h.tx_hash,
            height: h.height,
            confirmed: h.height > 0,
          })),
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_transaction",
  "Get detailed information about a transaction by its txid",
  {
    txid: z.string().length(64).describe("Transaction ID (64 hex characters)"),
  },
  async ({ txid }) => {
    try {
      await ensureConnected();
      const tx = await electrumx.getTransaction(txid, true);
      return { content: [jsonText(tx)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_block_header",
  "Get block header information by block height",
  {
    height: z.number().int().min(0).describe("Block height"),
  },
  async ({ height }) => {
    try {
      await ensureConnected();
      const header = await electrumx.getBlockHeader(height);
      return { content: [jsonText({ height, header })] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_estimate_fee",
  "Estimate transaction fee (in RXD per KB) for confirmation within N blocks",
  {
    blocks: z.number().int().min(1).max(100).default(6).describe("Target confirmation blocks (default: 6)"),
  },
  async ({ blocks }) => {
    try {
      await ensureConnected();
      const feePerKb = await electrumx.estimateFee(blocks);
      return {
        content: [jsonText({
          targetBlocks: blocks,
          feePerKb: feePerKb === -1 ? "insufficient data" : `${feePerKb} RXD`,
          note: "Radiant has very low fees, typically ~0.001 RXD per standard transaction",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_broadcast_transaction",
  "Broadcast a signed raw transaction to the Radiant network",
  {
    raw_tx: z.string().describe("Signed raw transaction in hexadecimal"),
  },
  async ({ raw_tx }) => {
    try {
      await ensureConnected();
      const txid = await electrumx.broadcastTransaction(raw_tx);
      return {
        content: [jsonText({ success: true, txid })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Glyph Tokens
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_token",
  "Get Glyph token information by token reference (txid:vout or txid_vout format)",
  {
    token_ref: z.string().describe("Token reference in txid:vout or txid_vout format"),
  },
  async ({ token_ref }) => {
    try {
      await ensureConnected();
      // Normalize format
      const ref = token_ref.replace(":", "_");
      const info = await electrumx.glyphGetTokenInfo(ref);
      if (!info) {
        return { content: [{ type: "text", text: `Token not found: ${token_ref}` }], isError: true };
      }
      return { content: [jsonText(info)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_list_tokens",
  "List all Glyph tokens held by a Radiant address",
  {
    address: z.string().describe("Radiant address"),
    limit: z.number().int().min(1).max(500).default(100).describe("Maximum tokens to return (default: 100)"),
  },
  async ({ address, limit }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const tokens = await electrumx.glyphListTokens(scripthash, limit);
      return { content: [jsonText({ address, tokens })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_token_balance",
  "Get balance of a specific Glyph token for an address",
  {
    address: z.string().describe("Radiant address"),
    token_ref: z.string().describe("Token reference (txid_vout)"),
  },
  async ({ address, token_ref }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const ref = token_ref.replace(":", "_");
      const balance = await electrumx.glyphGetBalance(scripthash, ref);
      return { content: [jsonText({ address, token_ref: ref, balance })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_search_tokens",
  "Search for Glyph tokens by name or ticker symbol",
  {
    query: z.string().describe("Search query (token name or ticker)"),
    protocols: z.array(z.number().int()).optional().describe("Filter by protocol IDs (1=FT, 2=NFT, 3=DAT, 4=dMint, etc.)"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max results (default: 50)"),
  },
  async ({ query, protocols, limit }) => {
    try {
      await ensureConnected();
      const results = await electrumx.glyphSearchTokens(query, protocols, limit);
      return { content: [jsonText({ query, results })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_token_metadata",
  "Get full CBOR metadata for a Glyph token (name, description, image, attributes, etc.)",
  {
    token_ref: z.string().describe("Token reference (txid_vout)"),
  },
  async ({ token_ref }) => {
    try {
      await ensureConnected();
      const ref = token_ref.replace(":", "_");
      const metadata = await electrumx.glyphGetMetadata(ref);
      return { content: [jsonText(metadata)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_token_history",
  "Get transaction history for a specific Glyph token",
  {
    token_ref: z.string().describe("Token reference (txid_vout)"),
    limit: z.number().int().min(1).max(500).default(100).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  },
  async ({ token_ref, limit, offset }) => {
    try {
      await ensureConnected();
      const ref = token_ref.replace(":", "_");
      const history = await electrumx.glyphGetHistory(ref, limit, offset);
      return { content: [jsonText({ token_ref: ref, history })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_tokens_by_type",
  "Get tokens filtered by type (FT, NFT, etc.)",
  {
    token_type: z.number().int().min(1).max(11).describe("Token type ID (1=FT, 2=NFT, 3=DAT, 4=dMint, 5=MUT, 6=BURN, 7=CONTAINER, 8=ENCRYPTED, 9=TIMELOCK, 10=AUTHORITY, 11=WAVE)"),
    limit: z.number().int().min(1).max(200).default(100).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  },
  async ({ token_type, limit, offset }) => {
    try {
      await ensureConnected();
      const typeName = GLYPH_PROTOCOLS[token_type as keyof typeof GLYPH_PROTOCOLS]?.name || "Unknown";
      const tokens = await electrumx.glyphGetTokensByType(token_type, limit, offset);
      return { content: [jsonText({ token_type, type_name: typeName, tokens })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_validate_protocols",
  "Validate a Glyph protocol combination (check if protocol IDs can be used together)",
  {
    protocols: z.array(z.number().int()).describe("Array of protocol IDs to validate"),
  },
  async ({ protocols }) => {
    try {
      await ensureConnected();
      const result = await electrumx.glyphValidateProtocols(protocols);
      return { content: [jsonText(result)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_parse_glyph_envelope",
  "Parse a Glyph envelope from raw script hex (decode token metadata from a transaction output)",
  {
    script_hex: z.string().describe("Script in hexadecimal"),
  },
  async ({ script_hex }) => {
    try {
      await ensureConnected();
      const parsed = await electrumx.glyphParseEnvelope(script_hex);
      return { content: [jsonText(parsed)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — dMint (Decentralized Mining)
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_dmint_contracts",
  "List active dMint (decentralized mining) contracts — mineable tokens with PoW distribution",
  {
    format: z.enum(["simple", "extended"]).default("extended").describe("Response format: 'simple' (ref+outputs) or 'extended' (full details)"),
  },
  async ({ format }) => {
    try {
      await ensureConnected();
      const contracts = await electrumx.dmintGetContracts(format);
      return { content: [jsonText(contracts)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_dmint_contract",
  "Get details for a specific dMint contract (difficulty, reward, algorithm, supply)",
  {
    ref: z.string().describe("Contract reference (72 hex chars)"),
  },
  async ({ ref }) => {
    try {
      await ensureConnected();
      const contract = await electrumx.dmintGetContract(ref);
      return { content: [jsonText(contract)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_dmint_by_algorithm",
  "Get dMint contracts filtered by mining algorithm",
  {
    algorithm: z.number().int().min(0).max(4).describe("Algorithm ID: 0=SHA256D, 1=BLAKE3, 2=K12, 3=ARGON2ID, 4=RANDOMX"),
  },
  async ({ algorithm }) => {
    try {
      await ensureConnected();
      const algoName = DMINT_ALGORITHMS[algorithm as keyof typeof DMINT_ALGORITHMS]?.name || "Unknown";
      const contracts = await electrumx.dmintGetByAlgorithm(algorithm);
      return { content: [jsonText({ algorithm, algorithm_name: algoName, contracts })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_get_most_profitable_dmint",
  "Get dMint contracts sorted by estimated profitability (reward/difficulty ratio)",
  {
    limit: z.number().int().min(1).max(50).default(10).describe("Number of contracts to return"),
  },
  async ({ limit }) => {
    try {
      await ensureConnected();
      const contracts = await electrumx.dmintGetMostProfitable(limit);
      return { content: [jsonText(contracts)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — WAVE Naming System
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_resolve_wave_name",
  "Resolve a WAVE name to its zone records (address, avatar, description, DNS records, etc.). WAVE is Radiant's on-chain naming system.",
  {
    name: z.string().describe("WAVE name to resolve (e.g., 'alice', 'myapp')"),
  },
  async ({ name }) => {
    try {
      await ensureConnected();
      const result = await electrumx.waveResolve(name);
      if (!result) {
        return { content: [jsonText({ name, available: true, message: "Name is not registered" })] };
      }
      return { content: [jsonText({ name, ...result as object })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_check_wave_available",
  "Check if a WAVE name is available for registration",
  {
    name: z.string().describe("WAVE name to check"),
  },
  async ({ name }) => {
    try {
      await ensureConnected();
      const result = await electrumx.waveCheckAvailable(name);
      return { content: [jsonText({ name, ...result as object })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_wave_reverse_lookup",
  "Find WAVE names owned by a Radiant address",
  {
    address: z.string().describe("Radiant address"),
    limit: z.number().int().min(1).max(200).default(100).describe("Max results"),
  },
  async ({ address, limit }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const names = await electrumx.waveReverseLookup(scripthash, limit);
      return { content: [jsonText({ address, names })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_wave_subdomains",
  "List subdomains (child names) of a WAVE name",
  {
    parent_name: z.string().describe("Parent WAVE name"),
    limit: z.number().int().min(1).max(200).default(100).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  },
  async ({ parent_name, limit, offset }) => {
    try {
      await ensureConnected();
      const subdomains = await electrumx.waveGetSubdomains(parent_name, limit, offset);
      return { content: [jsonText({ parent_name, subdomains })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_wave_stats",
  "Get WAVE naming system statistics (total names, cache size, etc.)",
  {},
  async () => {
    try {
      await ensureConnected();
      const stats = await electrumx.waveStats();
      return { content: [jsonText(stats)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Swap / DEX
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_swap_orders",
  "Get open swap orders for a trading pair (on-chain DEX orderbook)",
  {
    sell_ref: z.string().describe("Sell-side token reference (or 'rxd' for native RXD)"),
    buy_ref: z.string().describe("Buy-side token reference (or 'rxd' for native RXD)"),
    limit: z.number().int().min(1).max(200).default(100).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  },
  async ({ sell_ref, buy_ref, limit, offset }) => {
    try {
      await ensureConnected();
      const orders = await electrumx.swapGetOrders(sell_ref, buy_ref, limit, offset);
      return { content: [jsonText({ sell_ref, buy_ref, orders })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Utility / Reference
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_protocol_info",
  "Get information about all Glyph protocol types (IDs, names, descriptions, valid combinations)",
  {},
  async () => {
    try {
      await ensureConnected();
      const info = await electrumx.glyphGetProtocolInfo();
      return { content: [jsonText(info)] };
    } catch (err) {
      // Fallback to static data if server doesn't support this
      return { content: [jsonText(GLYPH_PROTOCOLS)] };
    }
  },
);

server.tool(
  "radiant_validate_address",
  "Validate a Radiant address and show its type (P2PKH or P2SH)",
  {
    address: z.string().describe("Address to validate"),
  },
  async ({ address }) => {
    const valid = isValidAddress(address);
    const type = valid
      ? address.startsWith("1") ? "P2PKH" : address.startsWith("3") ? "P2SH" : "Unknown"
      : null;
    return {
      content: [jsonText({
        address,
        valid,
        type,
        scripthash: valid ? addressToScripthash(address) : null,
      })],
    };
  },
);

server.tool(
  "radiant_create_wallet",
  "Generate a new Radiant wallet. Supports two modes: (1) random key (fast, no mnemonic) or (2) BIP39 mnemonic with BIP32 HD derivation (12-24 words, recoverable). WARNING: Store the WIF/mnemonic securely.",
  {
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Network (mainnet or testnet)"),
    mnemonic: z.boolean().default(false).describe("If true, generate a BIP39 mnemonic (12 words) with HD derivation instead of a random key"),
    word_count: z.enum(["12", "15", "18", "21", "24"]).default("12").describe("Mnemonic word count (only used if mnemonic=true)"),
    passphrase: z.string().default("").describe("Optional BIP39 passphrase (only used if mnemonic=true)"),
    path: z.string().default("m/44'/0'/0'/0/0").describe("BIP32 derivation path (only used if mnemonic=true)"),
  },
  async ({ network, mnemonic: useMnemonic, word_count, passphrase, path }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      if (useMnemonic) {
        const wc = parseInt(word_count, 10) as 12 | 15 | 18 | 21 | 24;
        const { wallet, mnemonic: phrase, path: derivPath } = AgentWallet.generateWithMnemonic(network, wc, passphrase, path);
        return {
          content: [jsonText({
            address: wallet.address,
            publicKey: wallet.getPublicKeyHex(),
            wif: wallet.getWIF(),
            mnemonic: phrase,
            derivationPath: derivPath,
            network,
            note: "Store the mnemonic phrase securely — it can recover this wallet. The WIF is the derived private key.",
          })],
        };
      }
      const wallet = AgentWallet.create(network);
      return {
        content: [jsonText({
          address: wallet.address,
          publicKey: wallet.getPublicKeyHex(),
          wif: wallet.getWIF(),
          network,
          note: "Store the WIF (Wallet Import Format) private key securely. Anyone with this key can spend funds at this address.",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_restore_wallet",
  "Restore a Radiant wallet from a BIP39 mnemonic phrase. Validates the mnemonic checksum and derives the private key via BIP32 HD derivation.",
  {
    mnemonic: z.string().describe("BIP39 mnemonic phrase (12-24 words, space-separated)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Network"),
    passphrase: z.string().default("").describe("Optional BIP39 passphrase"),
    path: z.string().default("m/44'/0'/0'/0/0").describe("BIP32 derivation path"),
  },
  async ({ mnemonic, network, passphrase, path }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const wallet = AgentWallet.fromMnemonic(mnemonic, network, passphrase, path);
      return {
        content: [jsonText({
          address: wallet.address,
          publicKey: wallet.getPublicKeyHex(),
          wif: wallet.getWIF(),
          derivationPath: path,
          network,
          valid: true,
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_decode_transaction",
  "Decode a raw transaction hex into its human-readable components (inputs, outputs, values). Fetches the transaction from ElectrumX in verbose mode.",
  {
    txid: z.string().length(64).describe("Transaction ID (64 hex chars)"),
  },
  async ({ txid }) => {
    try {
      await ensureConnected();
      const tx = await electrumx.getTransaction(txid, true);
      return { content: [jsonText(tx)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_get_swap_history",
  "Get trade history for a token on the on-chain DEX",
  {
    ref: z.string().describe("Token reference (txid_vout format)"),
    limit: z.number().int().min(1).max(500).default(100).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  },
  async ({ ref, limit, offset }) => {
    try {
      await ensureConnected();
      const history = await electrumx.requestWithRetry("swap.get_history", [ref, limit, offset]);
      return { content: [jsonText({ ref, history })] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_connection_health",
  "Check ElectrumX connection health: latency, connection status, and server info",
  {},
  async () => {
    try {
      await ensureConnected();
      const latency = await electrumx.ping();
      const tip = await electrumx.headersSubscribe();
      return {
        content: [jsonText({
          status: latency >= 0 ? "healthy" : "degraded",
          electrumx: {
            host: ELECTRUMX_HOST,
            port: ELECTRUMX_PORT,
            ssl: ELECTRUMX_SSL,
            connected: electrumx.isConnected(),
            latencyMs: latency,
          },
          chain: { height: tip.height, network: NETWORK },
          timestamp: Date.now(),
        })],
      };
    } catch (err) {
      return {
        content: [jsonText({
          status: "unhealthy",
          electrumx: { host: ELECTRUMX_HOST, port: ELECTRUMX_PORT, connected: false },
          error: errorText(err),
          timestamp: Date.now(),
        })],
        isError: true,
      };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Phase 5: On-Chain AI Primitives
// ════════════════════════════════════════════════════════════

// ─── 5.1 Inference Proofs ───

server.tool(
  "radiant_create_inference_proof",
  "Create a blake3 inference proof commitment: hash(modelHash || inputHash || output). Used to record AI inference results on-chain via the InferenceProof contract.",
  {
    model_hash: z.string().length(64).describe("Blake3 hash of the model weights (64 hex chars)"),
    input_hash: z.string().length(64).describe("Blake3 hash of the input data (64 hex chars)"),
    output_hex: z.string().describe("Inference output as hex string"),
  },
  async ({ model_hash, input_hash, output_hex }) => {
    try {
      const output = Buffer.from(output_hex, "hex");
      const proof = createInferenceProof(model_hash, input_hash, output);
      return {
        content: [jsonText({
          modelHash: proof.modelHash,
          inputHash: proof.inputHash,
          commitment: proof.commitment,
          timestamp: proof.timestamp,
          note: "Publish this commitment on-chain via the InferenceProof contract to create a verifiable inference record.",
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_verify_inference_proof",
  "Verify an inference proof commitment off-chain. Checks that blake3(modelHash || inputHash || output) matches the expected commitment.",
  {
    model_hash: z.string().length(64).describe("Blake3 hash of the model weights"),
    input_hash: z.string().length(64).describe("Blake3 hash of the input data"),
    output_hex: z.string().describe("Inference output as hex string"),
    commitment: z.string().length(64).describe("Expected commitment hash (64 hex chars)"),
  },
  async ({ model_hash, input_hash, output_hex, commitment }) => {
    try {
      const output = Buffer.from(output_hex, "hex");
      const valid = verifyInferenceProof(model_hash, input_hash, output, commitment);
      return {
        content: [jsonText({
          valid,
          modelHash: model_hash,
          inputHash: input_hash,
          commitment,
          message: valid ? "Inference proof is valid" : "Inference proof FAILED verification — data has been tampered with",
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ─── 5.2 Agent Identity ───

server.tool(
  "radiant_build_agent_profile",
  "Build an AI agent identity profile with blake3 commitment, suitable for on-chain registration via the AgentIdentity contract and WAVE naming system.",
  {
    address: z.string().describe("Agent's Radiant payment address"),
    description: z.string().describe("Human-readable description of the agent"),
    api_url: z.string().optional().describe("API endpoint URL"),
    capabilities: z.array(z.string()).describe("List of agent capabilities (e.g., ['research', 'translate', 'code'])"),
    pricing: z.string().optional().describe("Pricing info (e.g., '100sat/query')"),
    model: z.string().optional().describe("AI model identifier (e.g., 'gpt-4-turbo')"),
    wave_name: z.string().optional().describe("WAVE name to register (e.g., 'myagent')"),
  },
  async ({ address, description, api_url, capabilities, pricing, model, wave_name }) => {
    try {
      const profile = buildAgentProfile({
        address,
        description,
        apiUrl: api_url,
        capabilities,
        pricing,
        model,
        waveName: wave_name,
      });
      const waveRecords = buildAgentWaveRecords(profile);
      return {
        content: [jsonText({
          profile,
          waveRecords,
          note: "Use waveRecords as WAVE zone data when registering the agent's name. The profileCommitment is stored on-chain via the AgentIdentity contract.",
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_resolve_agent_identity",
  "Resolve an AI agent's identity from its WAVE name. Returns parsed capabilities, pricing, and API endpoint.",
  {
    wave_name: z.string().describe("Agent's WAVE name"),
  },
  async ({ wave_name }) => {
    try {
      await ensureConnected();
      const result = await electrumx.waveResolve(wave_name);
      if (!result) {
        return { content: [jsonText({ wave_name, found: false, message: "Agent not found" })] };
      }
      const zone = (result as { zone?: Record<string, unknown> }).zone || result as Record<string, unknown>;
      const agentProfile = parseAgentCapabilities(zone);
      return {
        content: [jsonText({
          wave_name,
          found: true,
          agent: agentProfile,
          rawZone: zone,
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ─── 5.3 Token-Gated Access ───

server.tool(
  "radiant_check_token_access",
  "Check if an address holds sufficient Glyph tokens to access a gated service (TokenGatedService contract pattern).",
  {
    address: z.string().describe("Address to check"),
    token_ref: z.string().describe("Service token reference (txid_vout)"),
    min_balance: z.number().int().min(1).describe("Minimum token balance required (in photons)"),
  },
  async ({ address, token_ref, min_balance }) => {
    try {
      await ensureConnected();
      const result = await checkTokenGatedAccess(electrumx, address, token_ref.replace(":", "_"), min_balance);
      return { content: [jsonText(result)] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ─── 5.4 Micropayment Channels ───

server.tool(
  "radiant_open_channel",
  "Create initial state for a micropayment channel between two agents (MicropaymentChannel contract pattern).",
  {
    channel_id: z.string().describe("Channel ID (typically the funding txid)"),
    agent_a: z.string().describe("Payer's public key hex (compressed, 66 chars)"),
    agent_b: z.string().describe("Payee's public key hex (compressed, 66 chars)"),
    capacity: z.number().int().min(1).describe("Total locked amount in photons"),
    timeout_blocks: z.number().int().min(1).default(1008).describe("Timeout in blocks before payer can reclaim (default: 1008 ≈ 3.5 days)"),
  },
  async ({ channel_id, agent_a, agent_b, capacity, timeout_blocks }) => {
    try {
      const state = openChannel(channel_id, agent_a, agent_b, capacity, timeout_blocks);
      return {
        content: [jsonText({
          ...state,
          summary: channelSummary(state),
          note: "Sign state updates off-chain. Either party can close the channel on-chain with the latest signed state.",
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_update_channel",
  "Update a micropayment channel state: transfer photons from payer (agentA) to payee (agentB).",
  {
    channel_id: z.string().describe("Channel ID"),
    agent_a: z.string().describe("Payer's public key hex"),
    agent_b: z.string().describe("Payee's public key hex"),
    capacity: z.number().int().describe("Total channel capacity in photons"),
    balance_a: z.number().int().describe("Current agentA balance in photons"),
    balance_b: z.number().int().describe("Current agentB balance in photons"),
    nonce: z.number().int().describe("Current state nonce"),
    timeout_blocks: z.number().int().describe("Timeout in blocks"),
    payment_amount: z.number().int().min(1).describe("Amount to transfer from agentA to agentB (photons)"),
  },
  async ({ channel_id, agent_a, agent_b, capacity, balance_a, balance_b, nonce, timeout_blocks, payment_amount }) => {
    try {
      const currentState = {
        channelId: channel_id,
        agentA: agent_a,
        agentB: agent_b,
        capacity,
        balanceA: balance_a,
        balanceB: balance_b,
        nonce,
        timeoutBlocks: timeout_blocks,
        stateCommitment: "",
      };
      const newState = updateChannel(currentState, payment_amount);
      return {
        content: [jsonText({
          ...newState,
          summary: channelSummary(newState),
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ─── 5.5 Data Marketplace ───

server.tool(
  "radiant_build_data_asset",
  "Build Glyph NFT metadata for a data marketplace asset (DataMarketplace contract pattern). Returns CBOR-ready metadata structure.",
  {
    ref: z.string().describe("NFT reference for this asset"),
    type: z.enum(["dataset", "model", "collection", "computation"]).describe("Asset type"),
    name: z.string().describe("Asset name"),
    description: z.string().describe("Asset description"),
    content_hash: z.string().length(64).describe("Blake3 hash of the content (64 hex chars)"),
    size_bytes: z.number().int().optional().describe("Content size in bytes"),
    mime_type: z.string().optional().describe("MIME type"),
    price: z.number().int().min(0).describe("Price in photons (0 = free/open)"),
    derived_from: z.array(z.string()).optional().describe("Parent dataset refs (for provenance)"),
    license: z.string().optional().describe("License terms (e.g., 'CC-BY-4.0')"),
  },
  async ({ ref, type, name, description, content_hash, size_bytes, mime_type, price, derived_from, license }) => {
    try {
      const asset: DataAsset = {
        ref,
        type,
        name,
        description,
        contentHash: content_hash,
        sizeBytes: size_bytes,
        mimeType: mime_type,
        price,
        derivedFrom: derived_from,
        license,
      };
      const metadata = buildDataAssetMetadata(asset);

      // Compute provenance if derived
      let provenanceCommitment: string | undefined;
      if (derived_from?.length) {
        provenanceCommitment = computeProvenanceCommitment(
          derived_from.map((r) => content_hash), // use content hashes as parent hashes
          `derived:${type}:${name}`,
        );
      }

      return {
        content: [jsonText({
          metadata,
          provenanceCommitment,
          note: "CBOR-encode this metadata for a Glyph commit-reveal token creation. The x-content-hash field enables buyers to verify data integrity.",
        })],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

server.tool(
  "radiant_search_data_assets",
  "Search the data marketplace for datasets, models, and other data assets (NFTs with DAT protocol).",
  {
    query: z.string().describe("Search query"),
    type: z.enum(["dataset", "model", "collection", "computation"]).optional().describe("Filter by asset type"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max results"),
  },
  async ({ query, type, limit }) => {
    try {
      await ensureConnected();
      const results = await searchDataAssets(electrumx, query, type, limit);
      return { content: [jsonText({ query, type, results })] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Script Decode (offline)
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_decode_script",
  "Decode raw script hex into human-readable opcodes. Works offline — no ElectrumX connection required. Useful for debugging transactions and smart contracts.",
  {
    script_hex: z.string().describe("Script in hexadecimal (e.g., '76a91489abcdef...88ac')"),
  },
  async ({ script_hex }) => {
    try {
      const { decodeScript } = await import("./script-decode.js");
      const decoded = decodeScript(script_hex);
      return { content: [jsonText(decoded)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Script Compile (offline)
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_compile_script",
  "Compile RadiantScript (.cash/.rxd) source code into a deployment artifact. Returns ABI, ASM bytecode, and hex. Works offline — requires the rxdc compiler binary (set RXDC_PATH env var or ensure RadiantScript repo is a sibling directory).",
  {
    source: z.string().describe("RadiantScript source code to compile"),
    format: z.enum(["artifact", "asm", "hex"]).default("artifact").describe("Output format: full artifact JSON, ASM text, or hex bytecode"),
    debug: z.boolean().default(false).describe("Include source code and source map in artifact for debugging with rxdeb"),
  },
  async ({ source, format, debug }) => {
    try {
      const { compileScript } = await import("./compiler.js");
      const result = await compileScript(source, { format, debug });
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Compilation error: ${result.error}\n${result.details || ""}` }], isError: true };
      }
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Token Transactions (requires WIF key)
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_send_rxd",
  "Send RXD (photons) to an address. Fetches UTXOs, selects coins, builds, signs, and broadcasts the transaction. Requires a WIF private key for the sender address.",
  {
    wif: z.string().describe("WIF-encoded private key of the sender"),
    to_address: z.string().describe("Recipient Radiant address"),
    satoshis: z.number().int().positive().describe("Amount to send in photons (satoshis). 1 RXD = 100,000,000 photons"),
    change_address: z.string().optional().describe("Change address (defaults to sender address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte (default: 1)"),
  },
  async ({ wif, to_address, satoshis, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { sendRxd } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const result = await sendRxd(electrumx, wallet.address, {
        wif,
        toAddress: to_address,
        satoshis,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_create_ft",
  "Mint a new Glyph Fungible Token (FT) on Radiant. Uses the 2-transaction commit+reveal pattern. Returns both transaction IDs and the token reference (tokenRef) for future transfers. Requires a WIF private key.",
  {
    wif: z.string().describe("WIF-encoded private key of the minter"),
    name: z.string().describe("Token name (e.g. 'My Token')"),
    ticker: z.string().describe("Token ticker symbol (e.g. 'MTK')"),
    supply: z.number().int().positive().describe("Total supply in base units (e.g. 1000000 for 10.000000 with 6 decimals)"),
    decimals: z.number().int().min(0).max(18).default(8).describe("Decimal places (default: 8)"),
    description: z.string().optional().describe("Token description"),
    image: z.string().optional().describe("Image URL or IPFS CID"),
    change_address: z.string().optional().describe("Change address (defaults to minter address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
  },
  async ({ wif, name, ticker, supply, decimals, description, image, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { createFungibleToken } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const metadata: Record<string, unknown> = { p: [1], name, ticker, decimals };
      if (description) metadata.desc = description;
      if (image) metadata.image = image;
      const result = await createFungibleToken(electrumx, wallet.address, {
        wif,
        supply,
        metadata: metadata as import("./tx-builder.js").GlyphMetadata,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_create_nft",
  "Mint a new Glyph Non-Fungible Token (NFT) on Radiant. Uses the 2-transaction commit+reveal pattern. Returns both transaction IDs and the token reference (tokenRef). Requires a WIF private key.",
  {
    wif: z.string().describe("WIF-encoded private key of the minter"),
    name: z.string().describe("NFT name"),
    description: z.string().optional().describe("NFT description"),
    image: z.string().optional().describe("Image URL or IPFS CID"),
    attributes: z.record(z.unknown()).optional().describe("Arbitrary NFT attributes as a JSON object"),
    change_address: z.string().optional().describe("Change address (defaults to minter address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
  },
  async ({ wif, name, description, image, attributes, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { createNFT } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const metadata: Record<string, unknown> = { p: [2], name };
      if (description) metadata.desc = description;
      if (image) metadata.image = image;
      if (attributes) metadata.attrs = attributes;
      const result = await createNFT(electrumx, wallet.address, {
        wif,
        metadata: metadata as import("./tx-builder.js").GlyphMetadata,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_transfer_token",
  "Transfer a Glyph token (FT or NFT) to another address. The token UTXO must be at the sender's address. For FTs provide the amount in base units; for NFTs use amount=1. Requires a WIF private key.",
  {
    wif: z.string().describe("WIF-encoded private key of the current token holder"),
    to_address: z.string().describe("Recipient Radiant address"),
    token_ref: z.string().describe("Token reference in txid_vout format (e.g. 'abc123...def_0')"),
    amount: z.number().int().positive().describe("Amount in base units to transfer (use 1 for NFTs)"),
    change_address: z.string().optional().describe("Change address (defaults to sender address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
  },
  async ({ wif, to_address, token_ref, amount, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { transferToken } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const result = await transferToken(electrumx, wallet.address, {
        wif,
        toAddress: to_address,
        tokenRef: token_ref,
        amount,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ════════════════════════════════════════════════════════════
//  TOOLS — Agent Enhancements (v1.4.0)
// ════════════════════════════════════════════════════════════

server.tool(
  "radiant_get_token_utxos",
  "Discover all Glyph tokens held by an address. Returns each token's UTXO reference (tokenRef), txid, vout, height, and satoshi value. Agents can use this to discover what they hold without prior knowledge of token references, then pass tokenRef directly to radiant_transfer_token or radiant_burn_token.",
  {
    address: z.string().describe("Radiant address to query"),
  },
  async ({ address }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const { getTokenUtxos } = await import("./tx-builder.js");
      const result = await getTokenUtxos(electrumx, address);
      return {
        content: [jsonText({
          address: result.address,
          tokenCount: result.tokens.length,
          tokens: result.tokens,
          rxdUtxoCount: result.allUtxos.length,
          totalRxdSatoshis: result.allUtxos.reduce((s, u) => s + u.value, 0),
          note: "Use tokenRef values with radiant_transfer_token or radiant_burn_token.",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_build_transaction",
  "Build and sign a transaction in dry-run mode — returns the raw hex, fee, and size WITHOUT broadcasting. Critical for high-value operations: inspect the transaction before committing. Set dry_run=false to also broadcast after building.",
  {
    wif: z.string().describe("WIF-encoded private key of the sender"),
    outputs: z.array(z.object({
      address: z.string().describe("Recipient Radiant address"),
      satoshis: z.number().int().positive().describe("Amount in photons"),
    })).min(1).describe("Array of {address, satoshis} outputs"),
    change_address: z.string().optional().describe("Change address (defaults to sender address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
    dry_run: z.boolean().default(true).describe("If true (default), build and sign but do NOT broadcast. Set false to broadcast."),
  },
  async ({ wif, outputs, change_address, fee_per_byte, dry_run }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { buildTransaction } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const result = await buildTransaction(electrumx, wallet.address, {
        wif,
        outputs,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
        dryRun: dry_run,
      });
      return { content: [jsonText(result)] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_estimate_tx_fee",
  "Estimate transaction fee in satoshis given input/output counts. Pure arithmetic — no network call. Use this to budget before building a transaction. Supports OP_RETURN outputs (e.g., for token minting).",
  {
    input_count: z.number().int().min(1).describe("Number of P2PKH inputs"),
    output_count: z.number().int().min(1).describe("Number of P2PKH outputs (include change output)"),
    op_return_sizes: z.array(z.number().int().min(0)).optional().describe("Sizes in bytes of any OP_RETURN data payloads (e.g., [80] for an 80-byte Glyph envelope)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte (default: 1)"),
  },
  async ({ input_count, output_count, op_return_sizes, fee_per_byte }) => {
    try {
      const { estimateTxFee } = await import("./tx-builder.js");
      const result = estimateTxFee({
        inputCount: input_count,
        outputCount: output_count,
        opReturnSizes: op_return_sizes,
        feePerByte: fee_per_byte,
      });
      return {
        content: [jsonText({
          ...result,
          note: `Standard P2PKH: input≈148B, output≈34B, overhead≈10B. Total for ${input_count}in/${output_count}out: ${result.estimatedBytes}B`,
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_send_batch",
  "Send RXD to multiple recipients in a single transaction. Much cheaper than N separate transactions — inputs are selected once and change is returned in a single output. Ideal for agent fan-out payments (e.g., paying multiple service providers).",
  {
    wif: z.string().describe("WIF-encoded private key of the sender"),
    outputs: z.array(z.object({
      address: z.string().describe("Recipient Radiant address"),
      satoshis: z.number().int().positive().describe("Amount in photons"),
    })).min(1).max(100).describe("Array of {address, satoshis} recipients (max 100)"),
    change_address: z.string().optional().describe("Change address (defaults to sender address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
  },
  async ({ wif, outputs, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { sendBatch } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const result = await sendBatch(electrumx, wallet.address, {
        wif,
        outputs,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return {
        content: [jsonText({
          ...result,
          recipientCount: outputs.length,
          totalSent: outputs.reduce((s, o) => s + o.satoshis, 0),
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_watch_address",
  "Subscribe to real-time payment notifications for a Radiant address via ElectrumX scripthash subscription. Returns the current status hash and subscribes to future changes. Notifications arrive as ElectrumX push events (blockchain.scripthash.subscribe). Use this instead of polling for payment detection.",
  {
    address: z.string().describe("Radiant address to watch"),
  },
  async ({ address }) => {
    try {
      if (!isValidAddress(address)) {
        return { content: [{ type: "text", text: "Error: Invalid Radiant address" }], isError: true };
      }
      await ensureConnected();
      const scripthash = addressToScripthash(address);
      const statusHash = await electrumx.subscribeScripthash(scripthash);
      const balance = await electrumx.getBalance(scripthash);
      const utxos = await electrumx.listUnspent(scripthash);
      return {
        content: [jsonText({
          address,
          scripthash,
          statusHash,
          currentBalance: {
            confirmed: { satoshis: balance.confirmed, rxd: satoshisToRxd(balance.confirmed) },
            unconfirmed: { satoshis: balance.unconfirmed, rxd: satoshisToRxd(balance.unconfirmed) },
          },
          utxoCount: (utxos as unknown[]).length,
          subscribed: true,
          note: "Address is now subscribed. ElectrumX will push notifications when the scripthash status changes (new tx received or confirmed). The statusHash changes whenever the UTXO set changes.",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_derive_address",
  "Derive a Radiant address from a BIP39 mnemonic and BIP32 derivation path. Lets agents manage per-task sub-wallets from a single root key. Returns the address, public key, and WIF for the derived key. Use different account/index values to generate isolated sub-wallets.",
  {
    mnemonic: z.string().describe("BIP39 mnemonic phrase (12-24 words, space-separated)"),
    path: z.string().default("m/44'/0'/0'/0/0").describe("BIP32 derivation path (e.g. m/44'/0'/0'/0/1 for second address, m/44'/0'/1'/0/0 for second account)"),
    network: z.enum(["mainnet", "testnet"]).default("mainnet").describe("Network"),
    passphrase: z.string().default("").describe("Optional BIP39 passphrase"),
  },
  async ({ mnemonic, path, network, passphrase }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const wallet = AgentWallet.fromMnemonic(mnemonic, network, passphrase, path);
      return {
        content: [jsonText({
          address: wallet.address,
          publicKey: wallet.getPublicKeyHex(),
          wif: wallet.getWIF(),
          derivationPath: path,
          network,
          note: "Derive different paths from the same mnemonic to create isolated sub-wallets for separate tasks or payment channels.",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "radiant_burn_token",
  "Permanently burn (destroy) a Glyph token using protocol 6 (explicit burn). Spends the token UTXO into an OP_FALSE OP_RETURN output with a Glyph burn envelope. Use this to retire tokens cleanly — the burn is recorded on-chain and verifiable. Requires a WIF private key.",
  {
    wif: z.string().describe("WIF-encoded private key of the token holder"),
    token_ref: z.string().describe("Token reference in txid_vout format (e.g. 'abc123...def_0'). Use radiant_get_token_utxos to discover refs."),
    amount: z.number().int().positive().describe("Amount to burn in base units (use full balance for NFT, or partial for FT)"),
    change_address: z.string().optional().describe("Change address for any leftover RXD (defaults to sender address)"),
    fee_per_byte: z.number().int().positive().default(1).describe("Fee rate in satoshis per byte"),
  },
  async ({ wif, token_ref, amount, change_address, fee_per_byte }) => {
    try {
      const { AgentWallet } = await import("./wallet.js");
      const { burnToken } = await import("./tx-builder.js");
      const wallet = AgentWallet.fromWIF(wif);
      await ensureConnected();
      const result = await burnToken(electrumx, wallet.address, {
        wif,
        tokenRef: token_ref,
        amount,
        changeAddress: change_address,
        feePerByte: fee_per_byte,
      });
      return {
        content: [jsonText({
          ...result,
          tokenRef: token_ref,
          amountBurned: amount,
          note: "Token has been permanently destroyed. The burn transaction is recorded on-chain with a Glyph protocol 6 envelope.",
        })],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ════════════════════════════════════════════════════════════
//  RESOURCES — Static reference data
// ════════════════════════════════════════════════════════════

server.resource(
  "chain-overview",
  "radiant://docs/chain-overview",
  {
    description: "Radiant blockchain overview: parameters, features, and ecosystem tools",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "radiant://docs/chain-overview", text: getChainOverview(), mimeType: "text/markdown" }],
  }),
);

server.resource(
  "opcode-reference",
  "radiant://docs/opcodes",
  {
    description: "Complete Radiant opcode reference table including V2 opcodes (BLAKE3, K12, shifts)",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "radiant://docs/opcodes", text: getOpcodeReference(), mimeType: "text/markdown" }],
  }),
);

server.resource(
  "protocol-reference",
  "radiant://docs/protocols",
  {
    description: "Glyph protocol IDs, dMint algorithm IDs, and DAA mode reference",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: "radiant://docs/protocols", text: getProtocolReference(), mimeType: "text/markdown" }],
  }),
);

server.resource(
  "network-params",
  "radiant://docs/network-params",
  {
    description: "Radiant network parameters (mainnet and testnet)",
    mimeType: "application/json",
  },
  async () => ({
    contents: [{
      uri: "radiant://docs/network-params",
      text: JSON.stringify(NETWORK_PARAMS, null, 2),
      mimeType: "application/json",
    }],
  }),
);

server.resource(
  "sdk-quickstart",
  "radiant://docs/sdk-quickstart",
  {
    description: "Quick start guide for building on Radiant with radiantjs",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{
      uri: "radiant://docs/sdk-quickstart",
      text: `# radiantjs Quick Start

## Install
\`\`\`bash
npm install @radiantblockchain/radiantjs
\`\`\`

## Create Address
\`\`\`javascript
const radiant = require('@radiantblockchain/radiantjs');
const privateKey = new radiant.PrivateKey();
console.log('Address:', privateKey.toAddress().toString());
console.log('WIF:', privateKey.toWIF());
\`\`\`

## Build Transaction
\`\`\`javascript
const tx = new radiant.Transaction()
  .from(utxos)              // Array of UTXO objects
  .to(toAddress, amount)     // Recipient and amount in satoshis
  .change(changeAddress)     // Change address
  .sign(privateKey);         // Sign with private key

const rawTx = tx.serialize();
// Broadcast rawTx via ElectrumX: blockchain.transaction.broadcast
\`\`\`

## UTXO Format
\`\`\`javascript
{
  txId: '...',       // Transaction ID (hex)
  outputIndex: 0,    // Output index (vout)
  script: '...',     // ScriptPubKey (hex)
  satoshis: 100000   // Value in satoshis
}
\`\`\`

## Key ElectrumX Methods
- \`blockchain.scripthash.get_balance\` — Get address balance
- \`blockchain.scripthash.listunspent\` — Get UTXOs
- \`blockchain.transaction.broadcast\` — Broadcast signed tx
- \`blockchain.transaction.get\` — Get tx details
- \`glyph.list_tokens\` — List Glyph tokens for address
- \`wave.resolve\` — Resolve WAVE name

## Address to Scripthash
ElectrumX indexes by scripthash = SHA256(scriptPubKey), byte-reversed.
For P2PKH address starting with '1':
  scriptPubKey = OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
  scripthash = SHA256(scriptPubKey).reverse().hex()
`,
      mimeType: "text/markdown",
    }],
  }),
);

server.resource(
  "knowledge-base",
  "radiant://docs/knowledge-base",
  {
    description: "Comprehensive Radiant blockchain AI knowledge base — opcodes, token protocols, APIs, SDK patterns, and network parameters in a single document",
    mimeType: "text/markdown",
  },
  async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const kbPath = path.resolve(__dirname, "../docs/RADIANT_AI_KNOWLEDGE_BASE.md");
    let text: string;
    try {
      text = fs.readFileSync(kbPath, "utf-8");
    } catch {
      // Fallback: inline summary if file not found (e.g., running from dist/)
      text = getChainOverview() + "\n\n" + getOpcodeReference() + "\n\n" + getProtocolReference();
    }
    return {
      contents: [{ uri: "radiant://docs/knowledge-base", text, mimeType: "text/markdown" }],
    };
  },
);

// ════════════════════════════════════════════════════════════
//  RESOURCES — Dynamic (live data)
// ════════════════════════════════════════════════════════════

server.resource(
  "chain-status",
  "radiant://chain/status",
  {
    description: "Live chain status: current height, tip hash, sync state",
    mimeType: "application/json",
  },
  async () => {
    try {
      await ensureConnected();
      const tip = await electrumx.headersSubscribe();
      const fee = await electrumx.estimateFee(6);
      return {
        contents: [{
          uri: "radiant://chain/status",
          text: JSON.stringify({ height: tip.height, headerHex: tip.hex, network: NETWORK, feePerKb: fee, timestamp: Date.now() }, null, 2),
          mimeType: "application/json",
        }],
      };
    } catch {
      return { contents: [{ uri: "radiant://chain/status", text: JSON.stringify({ error: "not connected" }), mimeType: "application/json" }] };
    }
  },
);

server.resource(
  "dmint-active",
  "radiant://dmint/active",
  {
    description: "Currently active dMint (decentralized mining) contracts",
    mimeType: "application/json",
  },
  async () => {
    try {
      await ensureConnected();
      const contracts = await electrumx.requestWithRetry("dmint.get_contracts", ["extended"]);
      return {
        contents: [{
          uri: "radiant://dmint/active",
          text: JSON.stringify(contracts, null, 2),
          mimeType: "application/json",
        }],
      };
    } catch {
      return { contents: [{ uri: "radiant://dmint/active", text: JSON.stringify({ error: "unavailable" }), mimeType: "application/json" }] };
    }
  },
);

server.resource(
  "network-fees",
  "radiant://network/fees",
  {
    description: "Current fee estimates for various confirmation targets",
    mimeType: "application/json",
  },
  async () => {
    try {
      await ensureConnected();
      const [fee1, fee3, fee6, fee12] = await Promise.all([
        electrumx.estimateFee(1),
        electrumx.estimateFee(3),
        electrumx.estimateFee(6),
        electrumx.estimateFee(12),
      ]);
      return {
        contents: [{
          uri: "radiant://network/fees",
          text: JSON.stringify({
            fees: { "1_block": fee1, "3_blocks": fee3, "6_blocks": fee6, "12_blocks": fee12 },
            unit: "RXD/kB",
            note: "Radiant has very low fees, typically ~0.001 RXD per standard transaction",
            timestamp: Date.now(),
          }, null, 2),
          mimeType: "application/json",
        }],
      };
    } catch {
      return { contents: [{ uri: "radiant://network/fees", text: JSON.stringify({ error: "unavailable" }), mimeType: "application/json" }] };
    }
  },
);

server.resource(
  "tokens-popular",
  "radiant://tokens/popular",
  {
    description: "Popular Glyph tokens: well-known fungible tokens and NFT collections on the Radiant network",
    mimeType: "application/json",
  },
  async () => {
    try {
      await ensureConnected();
      // Fetch FT (type 1) and NFT (type 2) tokens, take the top entries
      const [ftTokens, nftTokens] = await Promise.all([
        electrumx.glyphGetTokensByType(1, 20, 0),
        electrumx.glyphGetTokensByType(2, 20, 0),
      ]);
      return {
        contents: [{
          uri: "radiant://tokens/popular",
          text: JSON.stringify({
            fungible_tokens: ftTokens,
            nft_collections: nftTokens,
            note: "Top fungible tokens (FT) and NFT collections by on-chain activity",
            timestamp: Date.now(),
          }, null, 2),
          mimeType: "application/json",
        }],
      };
    } catch {
      return { contents: [{ uri: "radiant://tokens/popular", text: JSON.stringify({ error: "unavailable" }), mimeType: "application/json" }] };
    }
  },
);

// ════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Radiant MCP Server started (${NETWORK})`);
  console.error(`ElectrumX: ${ELECTRUMX_SSL ? "ssl" : "tcp"}://${ELECTRUMX_HOST}:${ELECTRUMX_PORT}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
