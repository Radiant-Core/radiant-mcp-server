/**
 * Live integration test: connect to real ElectrumX and test key tools.
 * Requires an accessible ElectrumX server.
 */
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../dist/index.js");

let child: ChildProcess;
let requestId = 0;
let stdoutBuf = "";

function sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++requestId;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin!.write(JSON.stringify(req) + "\n");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15_000);
    const handler = (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            child.stdout!.removeListener("data", handler);
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
            else resolve(parsed.result);
            return;
          }
        } catch {}
      }
    };
    child.stdout!.on("data", handler);
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await sendRequest("tools/call", { name, arguments: args }) as {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = result?.content?.[0]?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResource(uri: string): Promise<string> {
  const result = await sendRequest("resources/read", { uri }) as {
    contents?: Array<{ text: string }>;
  };
  return result?.contents?.[0]?.text || "";
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

async function main() {
  console.log("Starting radiant-mcp-server with live ElectrumX...\n");

  child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRUMX_HOST: "electrumx.radiant4people.com",
      ELECTRUMX_PORT: "50012",
      ELECTRUMX_SSL: "true",
    },
  });

  child.stderr!.on("data", () => {}); // Suppress stderr

  // Initialize MCP handshake
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "live-test", version: "1.0.0" },
  });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Wait a moment for server to be ready
  await new Promise(r => setTimeout(r, 500));

  try {
    // ─── Test 1: Chain Info ───
    console.log("Test 1: radiant_get_chain_info");
    const chainInfo = await callTool("radiant_get_chain_info") as Record<string, unknown>;
    assert(typeof chainInfo.height === "number" && chainInfo.height > 0, `height = ${chainInfo.height}`);
    assert(chainInfo.network === "mainnet", `network = ${chainInfo.network}`);
    assert(chainInfo.ticker === "RXD", `ticker = ${chainInfo.ticker}`);

    // ─── Test 2: Validate Address ───
    console.log("\nTest 2: radiant_validate_address");
    const addrResult = await callTool("radiant_validate_address", {
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    }) as Record<string, unknown>;
    assert(addrResult.valid === true, "valid address");
    assert(addrResult.type === "P2PKH", `type = ${addrResult.type}`);
    assert(typeof addrResult.scripthash === "string", "has scripthash");

    const invalidResult = await callTool("radiant_validate_address", {
      address: "INVALID_ADDRESS_XYZ",
    }) as Record<string, unknown>;
    assert(invalidResult.valid === false, "invalid address detected");

    // ─── Test 3: Get Balance ───
    console.log("\nTest 3: radiant_get_balance");
    const balance = await callTool("radiant_get_balance", {
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    }) as Record<string, unknown>;
    assert(typeof balance === "object" && balance !== null, "balance returned");
    const confirmed = balance.confirmed as Record<string, unknown> | undefined;
    assert(confirmed !== undefined && typeof confirmed.satoshis === "number", "has confirmed.satoshis");

    // ─── Test 4: Estimate Fee ───
    console.log("\nTest 4: radiant_estimate_fee");
    const fee = await callTool("radiant_estimate_fee", { blocks: 6 }) as Record<string, unknown>;
    assert(typeof fee.targetBlocks === "number", `targetBlocks = ${fee.targetBlocks}`);
    assert(fee.note !== undefined, "has fee note");

    // ─── Test 5: Block Header ───
    console.log("\nTest 5: radiant_get_block_header");
    const header = await callTool("radiant_get_block_header", { height: 1 }) as Record<string, unknown>;
    assert(header.height === 1, `height = ${header.height}`);
    assert(typeof header.header === "string", "has header hex");

    // ─── Test 6: Resources ───
    console.log("\nTest 6: Resources");
    const overview = await readResource("radiant://docs/chain-overview");
    assert(overview.includes("Radiant Blockchain"), "chain-overview has title");
    assert(overview.includes("SHA512/256"), "chain-overview has mining algo");

    const opcodes = await readResource("radiant://docs/opcodes");
    assert(opcodes.includes("OP_BLAKE3"), "opcodes has OP_BLAKE3");
    assert(opcodes.includes("OP_PUSHINPUTREF"), "opcodes has OP_PUSHINPUTREF");

    const protocols = await readResource("radiant://docs/protocols");
    assert(protocols.includes("GLYPH_FT"), "protocols has GLYPH_FT");
    assert(protocols.includes("GLYPH_DMINT"), "protocols has GLYPH_DMINT");
    assert(protocols.includes("BLAKE3"), "protocols has BLAKE3 algo");

    const params = await readResource("radiant://docs/network-params");
    const paramsJson = JSON.parse(params);
    assert(paramsJson.mainnet.ticker === "RXD", "params has RXD ticker");
    assert(paramsJson.mainnet.v2ActivationHeight === 410000, "params has v2 activation height");

    const quickstart = await readResource("radiant://docs/sdk-quickstart");
    assert(quickstart.includes("radiantjs"), "quickstart mentions radiantjs");
    assert(quickstart.includes("scripthash"), "quickstart mentions scripthash");

  } catch (err) {
    console.error("\nTest error:", err);
    failed++;
  }

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Live Test Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Live test crashed:", err);
  if (child) child.kill();
  process.exit(1);
});
