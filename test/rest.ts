/**
 * REST API integration test.
 * Starts the REST server, tests endpoints against live ElectrumX, then shuts down.
 */
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../dist/rest.js");

let child: ChildProcess;
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

function get(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${urlPath}`)), 15_000);
    http.get(`http://localhost:3080${urlPath}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { clearTimeout(timeout); resolve({ status: res.statusCode!, body: data }); });
    }).on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function getJson(urlPath: string): Promise<Record<string, unknown>> {
  const { body } = await get(urlPath);
  return JSON.parse(body);
}

async function main() {
  console.log("Starting REST API server...\n");

  child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRUMX_HOST: "electrumx.radiant4people.com",
      ELECTRUMX_PORT: "50012",
      ELECTRUMX_SSL: "true",
      PORT: "3080",
    },
  });

  // Wait for server to start
  await new Promise<void>((resolve) => {
    child.stderr!.on("data", () => {});
    child.stdout!.on("data", (data) => {
      if (data.toString().includes("started")) resolve();
    });
    setTimeout(resolve, 3000); // fallback
  });

  try {
    // ─── Test 1: Root ───
    console.log("Test 1: API root");
    const root = await getJson("/api");
    assert(root.name === "Radiant REST API", `name = ${root.name}`);
    assert(root.version === "1.0.0", `version = ${root.version}`);
    assert(Array.isArray(root.endpoints), "has endpoints list");

    // ─── Test 2: Chain Info ───
    console.log("\nTest 2: GET /api/chain");
    const chain = await getJson("/api/chain");
    assert(typeof chain.height === "number" && (chain.height as number) > 0, `height = ${chain.height}`);
    assert(chain.ticker === "RXD", `ticker = ${chain.ticker}`);
    assert(chain.network === "mainnet", `network = ${chain.network}`);

    // ─── Test 3: Block Header ───
    console.log("\nTest 3: GET /api/block/1");
    const block = await getJson("/api/block/1");
    assert(block.height === 1, `height = ${block.height}`);
    assert(typeof block.header === "string" && (block.header as string).length > 0, "has header hex");

    // ─── Test 4: Fee Estimate ───
    console.log("\nTest 4: GET /api/fee");
    const fee = await getJson("/api/fee");
    assert(fee.targetBlocks === 6, `targetBlocks = ${fee.targetBlocks}`);
    assert(typeof fee.feePerKb === "string", `feePerKb = ${fee.feePerKb}`);

    // ─── Test 5: Balance ───
    console.log("\nTest 5: GET /api/address/.../balance");
    const balance = await getJson("/api/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/balance");
    assert(balance.address === "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "correct address");
    const confirmed = balance.confirmed as Record<string, unknown>;
    assert(typeof confirmed?.satoshis === "number", "has confirmed.satoshis");
    assert(typeof confirmed?.rxd === "string", "has confirmed.rxd");

    // ─── Test 6: UTXOs ───
    console.log("\nTest 6: GET /api/address/.../utxos");
    const utxos = await getJson("/api/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/utxos");
    assert(typeof utxos.count === "number", `utxo count = ${utxos.count}`);
    assert(Array.isArray(utxos.utxos), "has utxos array");

    // ─── Test 7: History ───
    console.log("\nTest 7: GET /api/address/.../history");
    const history = await getJson("/api/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/history");
    assert(typeof history.count === "number", `tx count = ${history.count}`);
    assert(Array.isArray(history.transactions), "has transactions array");

    // ─── Test 8: Address Validation ───
    console.log("\nTest 8: GET /api/validate/...");
    const valid = await getJson("/api/validate/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert(valid.valid === true, "valid address");
    assert(valid.type === "P2PKH", `type = ${valid.type}`);

    const invalid = await getJson("/api/validate/BADADDRESS");
    assert(invalid.valid === false, "invalid address detected");

    // ─── Test 9: 404 ───
    console.log("\nTest 9: 404 handling");
    const { status } = await get("/api/nonexistent");
    assert(status === 404, `404 status = ${status}`);

    // ─── Test 10: CORS ───
    console.log("\nTest 10: CORS headers");
    const corsResp = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request("http://localhost:3080/api/chain", { method: "OPTIONS" }, resolve);
      req.end();
    });
    assert(corsResp.headers["access-control-allow-origin"] === "*", "CORS origin = *");

    // ─── Test 11: Docs endpoints ───
    console.log("\nTest 11: Documentation endpoints");
    const { body: overview } = await get("/api/docs/overview");
    assert(overview.includes("Radiant Blockchain"), "docs/overview has title");

    const { body: opcodes } = await get("/api/docs/opcodes");
    assert(opcodes.includes("OP_BLAKE3"), "docs/opcodes has OP_BLAKE3");

    const { body: protos } = await get("/api/docs/protocols");
    assert(protos.includes("GLYPH_FT"), "docs/protocols has GLYPH_FT");

  } catch (err) {
    console.error("\nTest error:", err);
    failed++;
  }

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`REST API Test Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("REST test crashed:", err);
  if (child) child.kill();
  process.exit(1);
});
