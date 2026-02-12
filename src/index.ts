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
    await electrumx.connect();
    await electrumx.serverVersion("radiant-mcp-server/1.0.0", "1.4");
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function jsonText(data: unknown) {
  return { type: "text" as const, text: JSON.stringify(data, null, 2) };
}

// ────────────────────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "radiant-mcp-server",
  version: "1.0.0",
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
      return { content: [{ type: "text", text: `Error: ${errorText(err)}` }], isError: true };
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
