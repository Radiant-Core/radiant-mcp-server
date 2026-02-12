#!/usr/bin/env node

/**
 * REST API server for Radiant blockchain.
 * Wraps the same ElectrumX client used by the MCP server into HTTP endpoints.
 *
 * Usage:
 *   node dist/rest.js                     # Start on default port 3080
 *   PORT=8080 node dist/rest.js           # Custom port
 *
 * Environment variables: same as MCP server (ELECTRUMX_HOST, ELECTRUMX_PORT, etc.)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
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
// Configuration
// ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3080", 10);
const ELECTRUMX_HOST = process.env.ELECTRUMX_HOST || "electrumx.radiant4people.com";
const ELECTRUMX_PORT = parseInt(process.env.ELECTRUMX_PORT || "50012", 10);
const ELECTRUMX_SSL = (process.env.ELECTRUMX_SSL || "true") !== "false";
const NETWORK = (process.env.RADIANT_NETWORK || "mainnet") as "mainnet" | "testnet";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ────────────────────────────────────────────────────────────
// ElectrumX client
// ────────────────────────────────────────────────────────────

const electrumx = new ElectrumxClient({
  host: ELECTRUMX_HOST,
  port: ELECTRUMX_PORT,
  ssl: ELECTRUMX_SSL,
  timeout: 30_000,
});

let connected = false;

async function ensureConnected(): Promise<void> {
  if (!connected || !electrumx.isConnected()) {
    await electrumx.connect();
    await electrumx.serverVersion("radiant-rest-api/1.0.0", "1.4");
    connected = true;
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const [pathPart, queryPart] = url.split("?");
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const [k, v] = pair.split("=");
      query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  }
  return { path: pathPart.replace(/\/+$/, "") || "/", query };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ────────────────────────────────────────────────────────────
// Route matching
// ────────────────────────────────────────────────────────────

type RouteHandler = (
  params: Record<string, string>,
  query: Record<string, string>,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_m, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method: method.toUpperCase(),
    pattern: new RegExp(`^/api${pattern}$`),
    paramNames,
    handler,
  });
}

function matchRoute(
  method: string,
  path: string,
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = path.match(r.pattern);
    if (match) {
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => (params[name] = match[i + 1]));
      return { handler: r.handler, params };
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
//  ROUTES — Blockchain
// ════════════════════════════════════════════════════════════

route("GET", "/chain", async (_p, _q, _req, res) => {
  await ensureConnected();
  const tip = await electrumx.headersSubscribe();
  const params = NETWORK_PARAMS[NETWORK];
  json(res, {
    height: tip.height,
    headerHex: tip.hex,
    network: NETWORK,
    ticker: params.ticker,
    miningAlgorithm: params.miningAlgorithm,
    blockTime: `${params.blockTime / 60} minutes`,
    maxBlockSize: `${params.maxBlockSize / 1_000_000} MB`,
    v2ActivationHeight: params.v2ActivationHeight,
  });
});

route("GET", "/block/:height", async (p, _q, _req, res) => {
  const height = parseInt(p.height, 10);
  if (isNaN(height) || height < 0) return error(res, "Invalid height");
  await ensureConnected();
  const header = await electrumx.getBlockHeader(height);
  json(res, { height, header });
});

route("GET", "/tx/:txid", async (p, _q, _req, res) => {
  if (!/^[0-9a-f]{64}$/i.test(p.txid)) return error(res, "Invalid txid");
  await ensureConnected();
  const tx = await electrumx.getTransaction(p.txid, true);
  json(res, tx);
});

route("POST", "/tx", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  const rawTx = body.raw_tx;
  if (!rawTx || typeof rawTx !== "string") return error(res, "Missing raw_tx");
  await ensureConnected();
  const txid = await electrumx.broadcastTransaction(rawTx);
  json(res, { success: true, txid });
});

route("GET", "/fee", async (_p, q, _req, res) => {
  const blocks = parseInt(q.blocks || "6", 10);
  await ensureConnected();
  const feePerKb = await electrumx.estimateFee(blocks);
  json(res, {
    targetBlocks: blocks,
    feePerKb: feePerKb === -1 ? "insufficient data" : `${feePerKb} RXD`,
    note: "Radiant has very low fees, typically ~0.001 RXD per transaction",
  });
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Address
// ════════════════════════════════════════════════════════════

route("GET", "/address/:address/balance", async (p, _q, _req, res) => {
  if (!isValidAddress(p.address)) return error(res, "Invalid address");
  await ensureConnected();
  const sh = addressToScripthash(p.address);
  const bal = await electrumx.getBalance(sh);
  json(res, {
    address: p.address,
    confirmed: { satoshis: bal.confirmed, rxd: satoshisToRxd(bal.confirmed) },
    unconfirmed: { satoshis: bal.unconfirmed, rxd: satoshisToRxd(bal.unconfirmed) },
    total: {
      satoshis: bal.confirmed + bal.unconfirmed,
      rxd: satoshisToRxd(bal.confirmed + bal.unconfirmed),
    },
  });
});

route("GET", "/address/:address/utxos", async (p, _q, _req, res) => {
  if (!isValidAddress(p.address)) return error(res, "Invalid address");
  await ensureConnected();
  const sh = addressToScripthash(p.address);
  const utxos = await electrumx.listUnspent(sh);
  json(res, {
    address: p.address,
    count: utxos.length,
    utxos: utxos.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      height: u.height,
      value: { satoshis: u.value, rxd: satoshisToRxd(u.value) },
    })),
  });
});

route("GET", "/address/:address/history", async (p, _q, _req, res) => {
  if (!isValidAddress(p.address)) return error(res, "Invalid address");
  await ensureConnected();
  const sh = addressToScripthash(p.address);
  const history = await electrumx.getHistory(sh);
  json(res, {
    address: p.address,
    count: history.length,
    transactions: history.map((h) => ({
      txid: h.tx_hash,
      height: h.height,
      confirmed: h.height > 0,
    })),
  });
});

route("GET", "/address/:address/tokens", async (p, q, _req, res) => {
  if (!isValidAddress(p.address)) return error(res, "Invalid address");
  const limit = parseInt(q.limit || "100", 10);
  await ensureConnected();
  const sh = addressToScripthash(p.address);
  const tokens = await electrumx.glyphListTokens(sh, limit);
  json(res, { address: p.address, tokens });
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Glyph Tokens
// ════════════════════════════════════════════════════════════

route("GET", "/token/:ref", async (p, _q, _req, res) => {
  await ensureConnected();
  const ref = p.ref.replace(":", "_");
  const info = await electrumx.glyphGetTokenInfo(ref);
  if (!info) return error(res, "Token not found", 404);
  json(res, info);
});

route("GET", "/token/:ref/metadata", async (p, _q, _req, res) => {
  await ensureConnected();
  const ref = p.ref.replace(":", "_");
  const metadata = await electrumx.glyphGetMetadata(ref);
  json(res, metadata);
});

route("GET", "/token/:ref/history", async (p, q, _req, res) => {
  const limit = parseInt(q.limit || "100", 10);
  const offset = parseInt(q.offset || "0", 10);
  await ensureConnected();
  const ref = p.ref.replace(":", "_");
  const history = await electrumx.glyphGetHistory(ref, limit, offset);
  json(res, { ref, history });
});

route("GET", "/tokens/search", async (_p, q, _req, res) => {
  const query = q.q;
  if (!query) return error(res, "Missing query parameter 'q'");
  const limit = parseInt(q.limit || "50", 10);
  const protocols = q.protocols ? q.protocols.split(",").map(Number) : undefined;
  await ensureConnected();
  const results = await electrumx.glyphSearchTokens(query, protocols, limit);
  json(res, { query, results });
});

route("GET", "/tokens/type/:typeId", async (p, q, _req, res) => {
  const typeId = parseInt(p.typeId, 10);
  if (typeId < 1 || typeId > 11) return error(res, "Invalid type ID (1-11)");
  const limit = parseInt(q.limit || "100", 10);
  const offset = parseInt(q.offset || "0", 10);
  const typeName = GLYPH_PROTOCOLS[typeId as keyof typeof GLYPH_PROTOCOLS]?.name || "Unknown";
  await ensureConnected();
  const tokens = await electrumx.glyphGetTokensByType(typeId, limit, offset);
  json(res, { type_id: typeId, type_name: typeName, tokens });
});

// ════════════════════════════════════════════════════════════
//  ROUTES — dMint
// ════════════════════════════════════════════════════════════

route("GET", "/dmint/contracts", async (_p, q, _req, res) => {
  const format = (q.format || "extended") as "simple" | "extended";
  await ensureConnected();
  const contracts = await electrumx.dmintGetContracts(format);
  json(res, contracts);
});

route("GET", "/dmint/contract/:ref", async (p, _q, _req, res) => {
  await ensureConnected();
  const contract = await electrumx.dmintGetContract(p.ref);
  json(res, contract);
});

route("GET", "/dmint/algorithm/:algoId", async (p, _q, _req, res) => {
  const algoId = parseInt(p.algoId, 10);
  const algoName = DMINT_ALGORITHMS[algoId as keyof typeof DMINT_ALGORITHMS]?.name || "Unknown";
  await ensureConnected();
  const contracts = await electrumx.dmintGetByAlgorithm(algoId);
  json(res, { algorithm: algoId, algorithm_name: algoName, contracts });
});

route("GET", "/dmint/profitable", async (_p, q, _req, res) => {
  const limit = parseInt(q.limit || "10", 10);
  await ensureConnected();
  const contracts = await electrumx.dmintGetMostProfitable(limit);
  json(res, contracts);
});

// ════════════════════════════════════════════════════════════
//  ROUTES — WAVE
// ════════════════════════════════════════════════════════════

route("GET", "/wave/resolve/:name", async (p, _q, _req, res) => {
  await ensureConnected();
  const result = await electrumx.waveResolve(p.name);
  if (!result) {
    json(res, { name: p.name, available: true, message: "Name is not registered" });
    return;
  }
  json(res, { name: p.name, ...(result as object) });
});

route("GET", "/wave/available/:name", async (p, _q, _req, res) => {
  await ensureConnected();
  const result = await electrumx.waveCheckAvailable(p.name);
  json(res, { name: p.name, ...(result as object) });
});

route("GET", "/wave/:name/subdomains", async (p, q, _req, res) => {
  const limit = parseInt(q.limit || "100", 10);
  const offset = parseInt(q.offset || "0", 10);
  await ensureConnected();
  const subdomains = await electrumx.waveGetSubdomains(p.name, limit, offset);
  json(res, { parent_name: p.name, subdomains });
});

route("GET", "/wave/stats", async (_p, _q, _req, res) => {
  await ensureConnected();
  const stats = await electrumx.waveStats();
  json(res, stats);
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Swap
// ════════════════════════════════════════════════════════════

route("GET", "/swap/orders", async (_p, q, _req, res) => {
  if (!q.sell || !q.buy) return error(res, "Missing 'sell' and 'buy' query params");
  const limit = parseInt(q.limit || "100", 10);
  const offset = parseInt(q.offset || "0", 10);
  await ensureConnected();
  const orders = await electrumx.swapGetOrders(q.sell, q.buy, limit, offset);
  json(res, { sell: q.sell, buy: q.buy, orders });
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Utility
// ════════════════════════════════════════════════════════════

route("GET", "/validate/:address", async (p, _q, _req, res) => {
  const valid = isValidAddress(p.address);
  const type = valid
    ? p.address.startsWith("1") ? "P2PKH" : p.address.startsWith("3") ? "P2SH" : "Unknown"
    : null;
  json(res, {
    address: p.address,
    valid,
    type,
    scripthash: valid ? addressToScripthash(p.address) : null,
  });
});

route("GET", "/protocols", async (_p, _q, _req, res) => {
  try {
    await ensureConnected();
    const info = await electrumx.glyphGetProtocolInfo();
    json(res, info);
  } catch {
    json(res, GLYPH_PROTOCOLS);
  }
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Documentation
// ════════════════════════════════════════════════════════════

route("GET", "/docs/overview", async (_p, _q, _req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });
  res.end(getChainOverview());
});

route("GET", "/docs/opcodes", async (_p, _q, _req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });
  res.end(getOpcodeReference());
});

route("GET", "/docs/protocols", async (_p, _q, _req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });
  res.end(getProtocolReference());
});

// ════════════════════════════════════════════════════════════
//  ROUTES — Phase 5: AI Primitives
// ════════════════════════════════════════════════════════════

// ─── Inference Proofs ───

route("POST", "/inference/proof", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  const { model_hash, input_hash, output_hex } = body;
  if (!model_hash || !input_hash || !output_hex) return error(res, "Missing model_hash, input_hash, or output_hex");
  const output = Buffer.from(output_hex, "hex");
  const proof = createInferenceProof(model_hash, input_hash, output);
  json(res, { modelHash: proof.modelHash, inputHash: proof.inputHash, commitment: proof.commitment, timestamp: proof.timestamp });
});

route("POST", "/inference/verify", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  const { model_hash, input_hash, output_hex, commitment } = body;
  if (!model_hash || !input_hash || !output_hex || !commitment) return error(res, "Missing required fields");
  const output = Buffer.from(output_hex, "hex");
  const valid = verifyInferenceProof(model_hash, input_hash, output, commitment);
  json(res, { valid, commitment, message: valid ? "Proof valid" : "Proof FAILED verification" });
});

// ─── Agent Identity ───

route("POST", "/identity/profile", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.address || !body.description || !body.capabilities) return error(res, "Missing address, description, or capabilities");
  const profile = buildAgentProfile({
    address: body.address,
    description: body.description,
    apiUrl: body.api_url,
    capabilities: body.capabilities,
    pricing: body.pricing,
    model: body.model,
    waveName: body.wave_name,
  });
  const waveRecords = buildAgentWaveRecords(profile);
  json(res, { profile, waveRecords });
});

route("GET", "/identity/resolve/:name", async (p, _q, _req, res) => {
  await ensureConnected();
  const result = await electrumx.waveResolve(p.name);
  if (!result) { json(res, { wave_name: p.name, found: false }); return; }
  const zone = (result as { zone?: Record<string, unknown> }).zone || result as Record<string, unknown>;
  const agentProfile = parseAgentCapabilities(zone);
  json(res, { wave_name: p.name, found: true, agent: agentProfile, rawZone: zone });
});

// ─── Token-Gated Access ───

route("GET", "/access/check/:address/:tokenRef", async (p, q, _req, res) => {
  if (!isValidAddress(p.address)) return error(res, "Invalid address");
  const minBalance = parseInt(q.min_balance || "1", 10);
  await ensureConnected();
  const result = await checkTokenGatedAccess(electrumx, p.address, p.tokenRef.replace(":", "_"), minBalance);
  json(res, result);
});

// ─── Micropayment Channels ───

route("POST", "/channel/open", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.channel_id || !body.agent_a || !body.agent_b || !body.capacity) return error(res, "Missing required fields");
  const state = openChannel(body.channel_id, body.agent_a, body.agent_b, body.capacity, body.timeout_blocks || 1008);
  json(res, { ...state, summary: channelSummary(state) });
});

route("POST", "/channel/update", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.channel_id || body.balance_a === undefined || body.payment_amount === undefined) return error(res, "Missing required fields");
  const currentState = {
    channelId: body.channel_id,
    agentA: body.agent_a,
    agentB: body.agent_b,
    capacity: body.capacity,
    balanceA: body.balance_a,
    balanceB: body.balance_b,
    nonce: body.nonce || 0,
    timeoutBlocks: body.timeout_blocks || 1008,
    stateCommitment: "",
  };
  const newState = updateChannel(currentState, body.payment_amount);
  json(res, { ...newState, summary: channelSummary(newState) });
});

// ─── Data Marketplace ───

route("POST", "/marketplace/asset", async (_p, _q, req, res) => {
  const body = JSON.parse(await readBody(req));
  if (!body.ref || !body.type || !body.name || !body.content_hash) return error(res, "Missing required fields");
  const asset: DataAsset = {
    ref: body.ref,
    type: body.type,
    name: body.name,
    description: body.description || "",
    contentHash: body.content_hash,
    sizeBytes: body.size_bytes,
    mimeType: body.mime_type,
    price: body.price || 0,
    derivedFrom: body.derived_from,
    license: body.license,
  };
  const metadata = buildDataAssetMetadata(asset);
  let provenanceCommitment: string | undefined;
  if (body.derived_from?.length) {
    provenanceCommitment = computeProvenanceCommitment(body.derived_from, `derived:${body.type}:${body.name}`);
  }
  json(res, { metadata, provenanceCommitment });
});

route("GET", "/marketplace/search", async (_p, q, _req, res) => {
  if (!q.q) return error(res, "Missing query parameter 'q'");
  const limit = parseInt(q.limit || "50", 10);
  await ensureConnected();
  const results = await searchDataAssets(electrumx, q.q, q.type as DataAsset["type"] | undefined, limit);
  json(res, { query: q.q, type: q.type, results });
});

// ─── Health Check ───

route("GET", "/health", async (_p, _q, _req, res) => {
  try {
    await ensureConnected();
    const latency = await electrumx.ping();
    json(res, {
      status: latency >= 0 ? "healthy" : "degraded",
      electrumx: { connected: electrumx.isConnected(), latencyMs: latency },
      network: NETWORK,
      timestamp: Date.now(),
    });
  } catch {
    json(res, { status: "unhealthy", electrumx: { connected: false }, network: NETWORK, timestamp: Date.now() }, 503);
  }
});

// ════════════════════════════════════════════════════════════
//  SERVER
// ════════════════════════════════════════════════════════════

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const { path, query } = parseUrl(req.url || "/");

  // Root: API info
  if (path === "/api" || path === "/") {
    json(res, {
      name: "Radiant REST API",
      version: "1.0.0",
      network: NETWORK,
      electrumx: `${ELECTRUMX_SSL ? "ssl" : "tcp"}://${ELECTRUMX_HOST}:${ELECTRUMX_PORT}`,
      docs: "/api/docs/overview",
      endpoints: routes.map((r) => ({
        method: r.method,
        path: r.pattern.source.replace(/\(\[\^\/\]\+\)/g, "{param}").replace(/[\\^$]/g, ""),
      })),
    });
    return;
  }

  const matched = matchRoute(req.method || "GET", path);
  if (!matched) {
    error(res, `Not found: ${req.method} ${path}`, 404);
    return;
  }

  try {
    await matched.handler(matched.params, query, req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${req.method} ${path}:`, msg);
    error(res, msg, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Radiant REST API started on http://localhost:${PORT}/api`);
  console.log(`Network: ${NETWORK}`);
  console.log(`ElectrumX: ${ELECTRUMX_SSL ? "ssl" : "tcp"}://${ELECTRUMX_HOST}:${ELECTRUMX_PORT}`);
  console.log(`CORS: ${CORS_ORIGIN}`);
});
