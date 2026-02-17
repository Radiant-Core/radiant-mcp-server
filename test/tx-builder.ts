/**
 * Transaction builder unit tests.
 * Tests coin selection, fee estimation, and transaction construction logic.
 * Does NOT require a live ElectrumX connection — uses a mock client.
 */

import {
  sendRxd,
  createFungibleToken,
  createNFT,
  transferToken,
  type RawUTXO,
} from "../src/tx-builder.js";
import type { ElectrumxClient } from "../src/electrumx.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

function assertThrows(fn: () => unknown, msgContains: string, label: string) {
  try {
    fn();
    console.log(`  ❌ ${label} (expected throw, got none)`);
    failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(msgContains)) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label} (wrong error: ${msg})`);
      failed++;
    }
  }
}

// ────────────────────────────────────────────────────────────
// Mock ElectrumX client
// ────────────────────────────────────────────────────────────

interface MockConfig {
  utxos?: RawUTXO[];
  broadcastResult?: string;
  broadcastError?: string;
}

function makeMockElectrumx(config: MockConfig = {}): ElectrumxClient {
  const utxos = config.utxos ?? [
    { tx_hash: "a".repeat(64), tx_pos: 0, height: 800000, value: 100_000_000 },
    { tx_hash: "b".repeat(64), tx_pos: 1, height: 800001, value:  50_000_000 },
  ];

  let callCount = 0;

  return {
    listUnspent: async (_scripthash: string) => {
      callCount++;
      return utxos;
    },
    broadcastTransaction: async (rawTx: string) => {
      if (config.broadcastError) throw new Error(config.broadcastError);
      // Return a deterministic fake txid based on the raw tx
      const { createHash } = await import("node:crypto");
      return createHash("sha256").update(rawTx).digest("hex");
    },
    // Satisfy the interface — other methods unused in these tests
    isConnected: () => true,
    connect: async () => {},
    disconnect: () => {},
    getBalance: async () => ({ confirmed: 0, unconfirmed: 0 }),
    getHistory: async () => [],
    getTransaction: async () => ({}),
    estimateFee: async () => 0.00001,
    broadcastTransaction_callCount: () => callCount,
  } as unknown as ElectrumxClient;
}

// ────────────────────────────────────────────────────────────
// Test wallet — generated fresh each run
// ────────────────────────────────────────────────────────────

let TEST_WIF = "";
let TEST_ADDRESS = "";

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log(" Transaction Builder Tests");
  console.log("═══════════════════════════════════════════════\n");

  // ── Generate test wallet ───────────────────────────────────
  const { AgentWallet } = await import("../src/wallet.js");
  const testWallet = AgentWallet.create("mainnet");
  TEST_WIF = testWallet.getWIF();
  TEST_ADDRESS = testWallet.address;
  console.log(`Test address: ${TEST_ADDRESS}\n`);

  // ── Module imports ─────────────────────────────────────────
  console.log("── Module Imports ──");
  try {
    const mod = await import("../src/tx-builder.js");
    assert(typeof mod.sendRxd === "function", "sendRxd is exported");
    assert(typeof mod.createFungibleToken === "function", "createFungibleToken is exported");
    assert(typeof mod.createNFT === "function", "createNFT is exported");
    assert(typeof mod.transferToken === "function", "transferToken is exported");
  } catch (e) {
    assert(false, `Module import failed: ${e}`);
  }

  // ── Coin selection — insufficient funds ───────────────────
  console.log("\n── Insufficient Funds ──");
  const emptyMock = makeMockElectrumx({ utxos: [] });
  try {
    await sendRxd(emptyMock, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 1_000_000,
    });
    assert(false, "Should throw on empty UTXOs");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(
      msg.includes("No UTXOs") || msg.includes("Insufficient"),
      `Throws on empty UTXOs: ${msg}`,
    );
  }

  const tinyMock = makeMockElectrumx({
    utxos: [{ tx_hash: "c".repeat(64), tx_pos: 0, height: 1, value: 100 }],
  });
  try {
    await sendRxd(tinyMock, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 100_000_000,
    });
    assert(false, "Should throw on insufficient funds");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("Insufficient") || msg.includes("funds"), `Throws on insufficient funds: ${msg}`);
  }

  // ── sendRxd — valid transaction ───────────────────────────
  console.log("\n── sendRxd ──");
  const mock1 = makeMockElectrumx();
  try {
    const result = await sendRxd(mock1, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 10_000_000,
    });
    assert(result.broadcasted === true, "sendRxd: broadcasted=true");
    assert(typeof result.txid === "string" && result.txid.length === 64, "sendRxd: txid is 64-char hex");
    assert(typeof result.rawTx === "string" && result.rawTx.length > 0, "sendRxd: rawTx is non-empty");
    assert(typeof result.fee === "number" && result.fee > 0, `sendRxd: fee > 0 (got ${result.fee})`);
    assert(result.inputCount >= 1, `sendRxd: inputCount >= 1 (got ${result.inputCount})`);
    assert(result.outputCount >= 1, `sendRxd: outputCount >= 1 (got ${result.outputCount})`);
  } catch (e) {
    assert(false, `sendRxd threw unexpectedly: ${e}`);
  }

  // ── sendRxd — custom fee rate ─────────────────────────────
  const mock2 = makeMockElectrumx();
  try {
    const r1 = await sendRxd(mock2, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 10_000_000,
      feePerByte: 1,
    });
    const mock3 = makeMockElectrumx();
    const r2 = await sendRxd(mock3, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 10_000_000,
      feePerByte: 5,
    });
    assert(r2.fee >= r1.fee, `Higher feePerByte produces higher fee (${r1.fee} vs ${r2.fee})`);
  } catch (e) {
    assert(false, `sendRxd fee rate test threw: ${e}`);
  }

  // ── createFungibleToken ───────────────────────────────────
  console.log("\n── createFungibleToken ──");
  const mock4 = makeMockElectrumx();
  try {
    const result = await createFungibleToken(mock4, TEST_ADDRESS, {
      wif: TEST_WIF,
      supply: 1_000_000,
      metadata: {
        p: [1],
        name: "Test Token",
        ticker: "TST",
        decimals: 6,
      },
    });
    assert(typeof result.commitTxid === "string" && result.commitTxid.length === 64, "createFT: commitTxid is hex");
    assert(typeof result.revealTxid === "string" && result.revealTxid.length === 64, "createFT: revealTxid is hex");
    assert(typeof result.tokenRef === "string" && result.tokenRef.includes("_"), "createFT: tokenRef has _ separator");
    assert(result.tokenRef.endsWith("_0"), "createFT: tokenRef ends with _0");
    assert(typeof result.commitRawTx === "string" && result.commitRawTx.length > 0, "createFT: commitRawTx non-empty");
    assert(typeof result.revealRawTx === "string" && result.revealRawTx.length > 0, "createFT: revealRawTx non-empty");
    assert(typeof result.commitFee === "number" && result.commitFee > 0, `createFT: commitFee > 0 (${result.commitFee})`);
    assert(typeof result.revealFee === "number" && result.revealFee > 0, `createFT: revealFee > 0 (${result.revealFee})`);
    assert(result.commitTxid !== result.revealTxid, "createFT: commit and reveal txids are different");
  } catch (e) {
    assert(false, `createFungibleToken threw: ${e}`);
  }

  // ── createNFT ─────────────────────────────────────────────
  console.log("\n── createNFT ──");
  const mock5 = makeMockElectrumx();
  try {
    const result = await createNFT(mock5, TEST_ADDRESS, {
      wif: TEST_WIF,
      metadata: {
        p: [2],
        name: "Test NFT",
        desc: "A test NFT",
        image: "ipfs://QmTest",
      },
    });
    assert(typeof result.commitTxid === "string" && result.commitTxid.length === 64, "createNFT: commitTxid is hex");
    assert(typeof result.revealTxid === "string" && result.revealTxid.length === 64, "createNFT: revealTxid is hex");
    assert(result.tokenRef.endsWith("_0"), "createNFT: tokenRef ends with _0");
  } catch (e) {
    assert(false, `createNFT threw: ${e}`);
  }

  // ── transferToken — token UTXO not found ─────────────────
  console.log("\n── transferToken ──");
  const mock6 = makeMockElectrumx();
  try {
    await transferToken(mock6, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      tokenRef: "deadbeef_0",
      amount: 1,
    });
    assert(false, "Should throw when token UTXO not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("not found") || msg.includes("UTXO"), `Throws when token UTXO not found: ${msg}`);
  }

  // ── transferToken — valid transfer ────────────────────────
  const tokenTxid = "a".repeat(64);
  const mock7 = makeMockElectrumx({
    utxos: [
      { tx_hash: tokenTxid, tx_pos: 0, height: 800000, value: 10_000_000 },
      { tx_hash: "b".repeat(64), tx_pos: 0, height: 800001, value: 50_000_000 },
    ],
  });
  try {
    const result = await transferToken(mock7, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      tokenRef: `${tokenTxid}_0`,
      amount: 1_000_000,
    });
    assert(result.broadcasted === true, "transferToken: broadcasted=true");
    assert(typeof result.txid === "string" && result.txid.length === 64, "transferToken: txid is hex");
    assert(typeof result.fee === "number" && result.fee > 0, `transferToken: fee > 0 (${result.fee})`);
  } catch (e) {
    assert(false, `transferToken threw: ${e}`);
  }

  // ── Broadcast error propagation ───────────────────────────
  console.log("\n── Error Propagation ──");
  const mockErr = makeMockElectrumx({ broadcastError: "Transaction rejected by mempool" });
  try {
    await sendRxd(mockErr, TEST_ADDRESS, {
      wif: TEST_WIF,
      toAddress: TEST_ADDRESS,
      satoshis: 1_000_000,
    });
    assert(false, "Should propagate broadcast error");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("rejected") || msg.includes("mempool"), `Broadcast error propagated: ${msg}`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
