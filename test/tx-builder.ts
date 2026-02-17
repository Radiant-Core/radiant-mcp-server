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
  getTokenUtxos,
  buildTransaction,
  estimateTxFee,
  sendBatch,
  burnToken,
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
  glyphTokens?: Array<{ ref: string }>;
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
      const { createHash } = await import("node:crypto");
      return createHash("sha256").update(rawTx).digest("hex");
    },
    glyphListTokens: async (_scripthash: string, _limit: number) => {
      return config.glyphTokens ?? [];
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

  // ── getTokenUtxos — empty token list ─────────────────────
  console.log("\n── getTokenUtxos ──");
  const mockTU1 = makeMockElectrumx({ glyphTokens: [] });
  try {
    const result = await getTokenUtxos(mockTU1, TEST_ADDRESS);
    assert(result.address === TEST_ADDRESS, "getTokenUtxos: address matches");
    assert(Array.isArray(result.tokens), "getTokenUtxos: tokens is array");
    assert(result.tokens.length === 0, "getTokenUtxos: empty token list returns 0 tokens");
    assert(Array.isArray(result.allUtxos), "getTokenUtxos: allUtxos is array");
    assert(result.allUtxos.length === 2, "getTokenUtxos: allUtxos has 2 entries from mock");
  } catch (e) {
    assert(false, `getTokenUtxos (empty) threw: ${e}`);
  }

  // ── getTokenUtxos — with token refs ──────────────────────
  const tokenTxidA = "a".repeat(64);
  const mockTU2 = makeMockElectrumx({
    utxos: [
      { tx_hash: tokenTxidA, tx_pos: 0, height: 800000, value: 10_000_000 },
      { tx_hash: "b".repeat(64), tx_pos: 0, height: 800001, value: 50_000_000 },
    ],
    glyphTokens: [
      { ref: `${tokenTxidA}_0` },
    ],
  });
  try {
    const result = await getTokenUtxos(mockTU2, TEST_ADDRESS);
    assert(result.tokens.length === 1, "getTokenUtxos: 1 token found");
    assert(result.tokens[0].tokenRef === `${tokenTxidA}_0`, "getTokenUtxos: tokenRef matches");
    assert(result.tokens[0].txid === tokenTxidA, "getTokenUtxos: txid extracted");
    assert(result.tokens[0].vout === 0, "getTokenUtxos: vout=0");
    assert(result.tokens[0].satoshis === 10_000_000, "getTokenUtxos: satoshis from UTXO");
  } catch (e) {
    assert(false, `getTokenUtxos (with tokens) threw: ${e}`);
  }

  // ── estimateTxFee — pure arithmetic ──────────────────────
  console.log("\n── estimateTxFee ──");
  try {
    const { estimateTxFee: estFee } = await import("../src/tx-builder.js");
    const r1 = estFee({ inputCount: 1, outputCount: 2 });
    assert(typeof r1.estimatedBytes === "number" && r1.estimatedBytes > 0, `estimateTxFee: estimatedBytes > 0 (${r1.estimatedBytes})`);
    assert(r1.feePerByte === 1, "estimateTxFee: default feePerByte=1");
    assert(r1.feeSatoshis === r1.estimatedBytes, "estimateTxFee: feeSatoshis = bytes * 1");
    assert(typeof r1.feeRxd === "string" && r1.feeRxd.includes("."), "estimateTxFee: feeRxd is decimal string");

    // Higher fee rate
    const r2 = estFee({ inputCount: 1, outputCount: 2, feePerByte: 5 });
    assert(r2.feeSatoshis === r1.feeSatoshis * 5, `estimateTxFee: 5x feePerByte = 5x fee (${r2.feeSatoshis} vs ${r1.feeSatoshis * 5})`);

    // More inputs → larger tx
    const r3 = estFee({ inputCount: 3, outputCount: 2 });
    assert(r3.estimatedBytes > r1.estimatedBytes, `estimateTxFee: 3 inputs > 1 input (${r3.estimatedBytes} vs ${r1.estimatedBytes})`);

    // OP_RETURN payload adds to size
    const r4 = estFee({ inputCount: 1, outputCount: 2, opReturnSizes: [80] });
    assert(r4.estimatedBytes > r1.estimatedBytes, `estimateTxFee: OP_RETURN adds bytes (${r4.estimatedBytes} vs ${r1.estimatedBytes})`);
  } catch (e) {
    assert(false, `estimateTxFee threw: ${e}`);
  }

  // ── buildTransaction — dry run ────────────────────────────
  console.log("\n── buildTransaction (dry-run) ──");
  const mockBT = makeMockElectrumx();
  try {
    const result = await buildTransaction(mockBT, TEST_ADDRESS, {
      wif: TEST_WIF,
      outputs: [{ address: TEST_ADDRESS, satoshis: 5_000_000 }],
      dryRun: true,
    });
    assert("broadcasted" in result && result.broadcasted === false, "buildTransaction dry-run: broadcasted=false");
    assert("rawTx" in result && typeof result.rawTx === "string" && result.rawTx.length > 0, "buildTransaction dry-run: rawTx non-empty");
    assert("fee" in result && typeof result.fee === "number" && result.fee > 0, `buildTransaction dry-run: fee > 0 (${(result as { fee: number }).fee})`);
    assert("sizeBytes" in result && (result as { sizeBytes: number }).sizeBytes > 0, "buildTransaction dry-run: sizeBytes > 0");
    assert("inputs" in result && Array.isArray((result as { inputs: unknown[] }).inputs), "buildTransaction dry-run: inputs array present");
    assert("outputs" in result && Array.isArray((result as { outputs: unknown[] }).outputs), "buildTransaction dry-run: outputs array present");
  } catch (e) {
    assert(false, `buildTransaction dry-run threw: ${e}`);
  }

  // ── buildTransaction — no outputs error ──────────────────
  const mockBT2 = makeMockElectrumx();
  try {
    await buildTransaction(mockBT2, TEST_ADDRESS, {
      wif: TEST_WIF,
      outputs: [],
    });
    assert(false, "buildTransaction: should throw on empty outputs");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("output"), `buildTransaction: throws on empty outputs: ${msg}`);
  }

  // ── sendBatch — multiple outputs ─────────────────────────
  console.log("\n── sendBatch ──");
  const mockSB = makeMockElectrumx();
  try {
    const result = await sendBatch(mockSB, TEST_ADDRESS, {
      wif: TEST_WIF,
      outputs: [
        { address: TEST_ADDRESS, satoshis: 1_000_000 },
        { address: TEST_ADDRESS, satoshis: 2_000_000 },
        { address: TEST_ADDRESS, satoshis: 3_000_000 },
      ],
    });
    assert(result.broadcasted === true, "sendBatch: broadcasted=true");
    assert(typeof result.txid === "string" && result.txid.length === 64, "sendBatch: txid is 64-char hex");
    assert(typeof result.fee === "number" && result.fee > 0, `sendBatch: fee > 0 (${result.fee})`);
    assert(result.outputCount >= 3, `sendBatch: outputCount >= 3 (${result.outputCount})`);
  } catch (e) {
    assert(false, `sendBatch threw: ${e}`);
  }

  // ── sendBatch — single output (same as sendRxd) ───────────
  const mockSB2 = makeMockElectrumx();
  try {
    const result = await sendBatch(mockSB2, TEST_ADDRESS, {
      wif: TEST_WIF,
      outputs: [{ address: TEST_ADDRESS, satoshis: 5_000_000 }],
    });
    assert(result.broadcasted === true, "sendBatch single: broadcasted=true");
    assert(result.inputCount >= 1, "sendBatch single: inputCount >= 1");
  } catch (e) {
    assert(false, `sendBatch single threw: ${e}`);
  }

  // ── sendBatch — empty outputs error ──────────────────────
  const mockSB3 = makeMockElectrumx();
  try {
    await sendBatch(mockSB3, TEST_ADDRESS, { wif: TEST_WIF, outputs: [] });
    assert(false, "sendBatch: should throw on empty outputs");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("output"), `sendBatch: throws on empty outputs: ${msg}`);
  }

  // ── burnToken — token UTXO not found ─────────────────────
  console.log("\n── burnToken ──");
  const mockBurn1 = makeMockElectrumx();
  try {
    await burnToken(mockBurn1, TEST_ADDRESS, {
      wif: TEST_WIF,
      tokenRef: "deadbeef_0",
      amount: 1,
    });
    assert(false, "burnToken: should throw when token UTXO not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("not found") || msg.includes("UTXO"), `burnToken: throws when token not found: ${msg}`);
  }

  // ── burnToken — valid burn ────────────────────────────────
  const burnTxid = "a".repeat(64);
  const mockBurn2 = makeMockElectrumx({
    utxos: [
      { tx_hash: burnTxid, tx_pos: 0, height: 800000, value: 10_000_000 },
      { tx_hash: "b".repeat(64), tx_pos: 0, height: 800001, value: 50_000_000 },
    ],
  });
  try {
    const result = await burnToken(mockBurn2, TEST_ADDRESS, {
      wif: TEST_WIF,
      tokenRef: `${burnTxid}_0`,
      amount: 1,
    });
    assert(result.broadcasted === true, "burnToken: broadcasted=true");
    assert(typeof result.txid === "string" && result.txid.length === 64, "burnToken: txid is hex");
    assert(typeof result.burnScript === "string" && result.burnScript.length > 0, "burnToken: burnScript non-empty");
    assert(typeof result.fee === "number" && result.fee > 0, `burnToken: fee > 0 (${result.fee})`);
  } catch (e) {
    assert(false, `burnToken threw: ${e}`);
  }

  // ── deriveAddress — BIP39/BIP32 ──────────────────────────
  console.log("\n── deriveAddress (BIP39/BIP32) ──");
  try {
    const { AgentWallet } = await import("../src/wallet.js");
    const { wallet: w1, mnemonic: phrase } = AgentWallet.generateWithMnemonic("mainnet", 12);

    // Derive index 0
    const d0 = AgentWallet.fromMnemonic(phrase, "mainnet", "", "m/44'/0'/0'/0/0");
    assert(typeof d0.address === "string" && d0.address.length > 0, "deriveAddress: index 0 has address");
    assert(d0.address === w1.address, "deriveAddress: same mnemonic+path yields same address");

    // Derive index 1 — different address
    const d1 = AgentWallet.fromMnemonic(phrase, "mainnet", "", "m/44'/0'/0'/0/1");
    assert(d1.address !== d0.address, "deriveAddress: index 1 differs from index 0");

    // Derive account 1 — different address
    const d2 = AgentWallet.fromMnemonic(phrase, "mainnet", "", "m/44'/0'/1'/0/0");
    assert(d2.address !== d0.address, "deriveAddress: account 1 differs from account 0");
    assert(d2.address !== d1.address, "deriveAddress: account 1 differs from index 1");

    // Passphrase changes derivation
    const dPass = AgentWallet.fromMnemonic(phrase, "mainnet", "secret", "m/44'/0'/0'/0/0");
    assert(dPass.address !== d0.address, "deriveAddress: passphrase changes address");

    // WIF is valid (can round-trip)
    const wif = d0.getWIF();
    const restored = AgentWallet.fromWIF(wif);
    assert(restored.address === d0.address, "deriveAddress: WIF round-trip restores address");
  } catch (e) {
    assert(false, `deriveAddress threw: ${e}`);
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
