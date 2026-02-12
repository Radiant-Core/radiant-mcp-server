/**
 * Smoke test: verify MCP server starts, lists tools and resources.
 * Does NOT require a live ElectrumX connection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function main() {
  // We can't easily import our server as a module (it auto-starts),
  // so we'll test the MCP init handshake by spawning it as a child process
  // and sending JSON-RPC over stdin/stdout.

  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(__dirname, "../dist/index.js");

  console.log("Starting radiant-mcp-server...");

  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Use a non-existent host so we don't actually connect
      ELECTRUMX_HOST: "127.0.0.1",
      ELECTRUMX_PORT: "59999",
      ELECTRUMX_SSL: "false",
    },
  });

  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Send MCP initialize request
  const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  };

  child.stdin.write(JSON.stringify(initRequest) + "\n");

  // Read response
  const response = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for init response"));
    }, 5000);

    let buf = "";
    child.stdout.on("data", (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
          clearTimeout(timeout);
          resolve(line);
          return;
        } catch {}
      }
    });
  });

  const initResult = JSON.parse(response);
  console.log("\n=== Initialize Response ===");
  console.log(JSON.stringify(initResult, null, 2));

  // Send initialized notification
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }) + "\n");

  // List tools
  const listToolsReq = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };
  child.stdin.write(JSON.stringify(listToolsReq) + "\n");

  const toolsResponse = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
    let buf = "";
    const handler = (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 2) {
            clearTimeout(timeout);
            child.stdout.removeListener("data", handler);
            resolve(line);
            return;
          }
        } catch {}
      }
    };
    child.stdout.on("data", handler);
  });

  const toolsResult = JSON.parse(toolsResponse);
  const toolNames = toolsResult.result?.tools?.map((t: { name: string }) => t.name) || [];
  console.log(`\n=== Tools (${toolNames.length}) ===`);
  for (const name of toolNames) {
    console.log(`  - ${name}`);
  }

  // List resources
  const listResourcesReq = {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
    params: {},
  };
  child.stdin.write(JSON.stringify(listResourcesReq) + "\n");

  const resourcesResponse = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
    let buf = "";
    const handler = (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 3) {
            clearTimeout(timeout);
            child.stdout.removeListener("data", handler);
            resolve(line);
            return;
          }
        } catch {}
      }
    };
    child.stdout.on("data", handler);
  });

  const resourcesResult = JSON.parse(resourcesResponse);
  const resourceNames = resourcesResult.result?.resources?.map(
    (r: { name: string; uri: string }) => `${r.name} (${r.uri})`
  ) || [];
  console.log(`\n=== Resources (${resourceNames.length}) ===`);
  for (const name of resourceNames) {
    console.log(`  - ${name}`);
  }

  // Summary
  console.log("\n=== Smoke Test Results ===");
  const serverName = initResult.result?.serverInfo?.name;
  const serverVersion = initResult.result?.serverInfo?.version;
  console.log(`Server: ${serverName} v${serverVersion}`);
  console.log(`Protocol: ${initResult.result?.protocolVersion}`);
  console.log(`Tools: ${toolNames.length}`);
  console.log(`Resources: ${resourceNames.length}`);

  const pass = toolNames.length >= 42 && resourceNames.length >= 9;
  console.log(`\nResult: ${pass ? "✅ PASS" : "❌ FAIL"}`);

  if (stderr) {
    console.log("\nServer stderr:", stderr.trim());
  }

  child.kill();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
