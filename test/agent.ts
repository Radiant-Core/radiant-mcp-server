/**
 * Agent SDK integration test.
 * Tests wallet management, spending limits, balance queries, and event monitoring.
 */

import { RadiantAgent, AgentWallet } from "../src/agent.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

async function main() {
  // ─── Test 1: Wallet Creation ───
  console.log("Test 1: Wallet creation");
  const w1 = AgentWallet.create("mainnet");
  const info1 = w1.getInfo();
  assert(info1.address.startsWith("1"), `address starts with 1: ${info1.address}`);
  assert(info1.publicKey.length === 66, `pubkey is 33 bytes compressed: ${info1.publicKey.length / 2} bytes`);
  assert(info1.wif.startsWith("K") || info1.wif.startsWith("L"), `WIF starts with K or L: ${info1.wif[0]}`);
  assert(info1.network === "mainnet", `network = mainnet`);

  // ─── Test 2: WIF Round-Trip ───
  console.log("\nTest 2: WIF import/export round-trip");
  const wif = w1.getWIF();
  const w2 = AgentWallet.fromWIF(wif);
  assert(w2.address === w1.address, `restored address matches: ${w2.address}`);
  assert(w2.getWIF() === wif, "WIF round-trip matches");
  assert(w2.getPublicKeyHex() === w1.getPublicKeyHex(), "pubkey matches");

  // ─── Test 3: Multiple Wallets are Unique ───
  console.log("\nTest 3: Multiple wallets are unique");
  const w3 = AgentWallet.create();
  const w4 = AgentWallet.create();
  assert(w3.address !== w4.address, `w3 ${w3.address.slice(0, 10)}... ≠ w4 ${w4.address.slice(0, 10)}...`);

  // ─── Test 4: Testnet Wallet ───
  console.log("\nTest 4: Testnet wallet");
  const wt = AgentWallet.create("testnet");
  assert(wt.address.startsWith("m") || wt.address.startsWith("n"), `testnet address prefix: ${wt.address[0]}`);
  assert(wt.getInfo().network === "testnet", "network = testnet");

  // ─── Test 5: Hex Import ───
  console.log("\nTest 5: Hex private key import");
  const hexKey = w1.getPrivateKeyBuffer().toString("hex");
  const w5 = AgentWallet.fromHex(hexKey);
  assert(w5.address === w1.address, "hex import matches original address");

  // ─── Test 6: Agent Initialization ───
  console.log("\nTest 6: Agent initialization");
  const agent = new RadiantAgent({
    network: "mainnet",
    electrumxHost: "electrumx.radiant4people.com",
    electrumxPort: 50012,
    electrumxSsl: true,
    spendLimitPerTx: 100_00000000, // 100 RXD
    spendLimitPerHour: 1000_00000000, // 1000 RXD
  });
  assert(!agent.hasWallet(), "no wallet initially");

  // ─── Test 7: Agent Wallet Management ───
  console.log("\nTest 7: Agent wallet management");
  const walletInfo = agent.createWallet();
  assert(agent.hasWallet(), "wallet created");
  assert(walletInfo.address.startsWith("1"), `wallet address: ${walletInfo.address.slice(0, 15)}...`);
  assert(agent.getAddress() === walletInfo.address, "getAddress() matches");

  // ─── Test 8: Spending Limits ───
  console.log("\nTest 8: Spending limits");
  const check1 = agent.checkSpendLimit(50_00000000); // 50 RXD
  assert(check1.allowed === true, "50 RXD allowed (limit: 100)");

  const check2 = agent.checkSpendLimit(150_00000000); // 150 RXD
  assert(check2.allowed === false, "150 RXD blocked (limit: 100)");
  assert(check2.reason!.includes("per-transaction"), `reason mentions per-transaction limit`);

  // Record some spending
  agent.recordSpend(50_00000000, "abc123", "test spend 1");
  agent.recordSpend(50_00000000, "def456", "test spend 2");

  const hourly = agent.getHourlySpending();
  assert(hourly.photons === 100_00000000, `hourly spending = ${hourly.rxd} RXD`);

  const history = agent.getSpendingHistory();
  assert(history.length === 2, `spending history has 2 records`);

  // ─── Test 9: Hourly Limit ───
  console.log("\nTest 9: Hourly spend limit");
  // Already spent 100 RXD, per-tx limit is 100 RXD, hourly limit is 1000 RXD
  // 95 RXD is under per-tx limit; 100+95+95+...would eventually exceed hourly
  agent.recordSpend(90_00000000, "ghi789", "test spend 3"); // now 190 RXD spent
  agent.recordSpend(90_00000000, "jkl012", "test spend 4"); // now 280 RXD spent

  const check3 = agent.checkSpendLimit(90_00000000); // 90 RXD per-tx OK, 280+90=370 < 1000
  assert(check3.allowed === true, "90 RXD allowed (per-tx OK, hourly 280+90=370 < 1000)");

  // Push spending near hourly limit
  for (let i = 0; i < 7; i++) agent.recordSpend(90_00000000); // +630 → 910 total
  const check4 = agent.checkSpendLimit(95_00000000); // 910+95=1005 > 1000
  assert(check4.allowed === false, "95 RXD blocked (hourly: 910+95 > 1000)");

  // ─── Test 10: Address Validation ───
  console.log("\nTest 10: Address validation");
  assert(agent.validateAddress(walletInfo.address) === true, "wallet address valid");
  assert(agent.validateAddress("INVALID") === false, "invalid address rejected");

  // ─── Test 11: Network Params ───
  console.log("\nTest 11: Network params and protocol info");
  const params = agent.getNetworkParams();
  assert(params.ticker === "RXD", `ticker = ${params.ticker}`);
  assert(params.v2ActivationHeight === 410_000, `v2 activation = ${params.v2ActivationHeight}`);

  const protocols = agent.getProtocols();
  assert((protocols as Record<string, {name: string}>)[1].name === "GLYPH_FT", "protocol 1 = GLYPH_FT");

  const algos = agent.getAlgorithms();
  assert((algos as Record<string, {name: string}>)[1].name === "BLAKE3", "algo 1 = BLAKE3");

  // ─── Test 12: Live ElectrumX Queries ───
  console.log("\nTest 12: Live ElectrumX queries");
  try {
    await agent.connect();

    const tip = await agent.getChainTip();
    assert(tip.height > 400_000, `chain height = ${tip.height}`);

    const fee = await agent.estimateFee(6);
    assert(typeof fee === "number", `fee estimate = ${fee}`);

    // Balance of a known address
    const bal = await agent.getBalance("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert(bal.confirmed.photons > 0, `genesis address balance = ${bal.confirmed.rxd} RXD`);

    // UTXOs
    const utxos = await agent.getUTXOs("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert(utxos.length > 0, `genesis address has ${utxos.length} UTXOs`);

    // History
    const history = await agent.getHistory("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert(history.length > 0, `genesis address has ${history.length} transactions`);

    await agent.disconnect();
  } catch (err) {
    console.error("  Live test error:", err);
    failed++;
  }

  // ─── Test 13: Connection URL Parsing ───
  console.log("\nTest 13: Connection URL parsing");
  const agent2 = new RadiantAgent({
    electrumx: "ssl://electrumx.radiant4people.com:50012",
  });
  assert(agent2.getNetworkParams().ticker === "RXD", "agent from URL string works");

  // ─── Test 14: Import Wallet via Agent ───
  console.log("\nTest 14: Import wallet via agent");
  const agent3 = new RadiantAgent();
  const imported = agent3.importWallet(walletInfo.wif);
  assert(imported.address === walletInfo.address, "imported wallet matches");

  // ─── Test 15: Spend Limit Warning Event ───
  console.log("\nTest 15: Spend limit warning event");
  const warnAgent = new RadiantAgent({ spendLimitPerHour: 100_00000000 });
  warnAgent.createWallet();
  let warningReceived = false;
  warnAgent.on("spend-limit-warning", () => { warningReceived = true; });
  warnAgent.recordSpend(85_00000000); // 85% of limit → triggers warning
  assert(warningReceived, "spend-limit-warning event emitted at 85%");

  // ─── Test 16: Audit Logging ───
  console.log("\nTest 16: Audit logging");
  const auditAgent = new RadiantAgent({ spendLimitPerHour: 1000_00000000 });
  auditAgent.createWallet();
  let auditEventReceived = false;
  auditAgent.on("audit", () => { auditEventReceived = true; });

  // Create a session key to trigger audit
  auditAgent.createSessionKey(["read", "query"], 60_000);
  assert(auditEventReceived, "audit event emitted on session key creation");

  const auditLog = auditAgent.getAuditLog();
  assert(auditLog.length >= 1, `audit log has ${auditLog.length} entries`);
  assert(auditLog[0].action === "session_key_created", `first entry: ${auditLog[0].action}`);
  assert(auditLog[0].success === true, "audit entry marked success");

  // Filter by action
  const filtered = auditAgent.getAuditLog({ action: "session_key_created" });
  assert(filtered.length === 1, "filtered audit log has 1 entry");

  // Clear
  auditAgent.clearAuditLog();
  assert(auditAgent.getAuditLog().length === 0, "audit log cleared");

  // ─── Test 17: Session Keys ───
  console.log("\nTest 17: Session keys");
  const sessionAgent = new RadiantAgent();
  sessionAgent.createWallet();

  // No session key initially
  assert(sessionAgent.getSessionKey() === null, "no session key initially");
  assert(sessionAgent.sessionHasPermission("read") === false, "no permission without session");

  // Create session key
  const sessionInfo = sessionAgent.createSessionKey(["read", "query", "balance"], 60_000);
  assert(sessionInfo.address.startsWith("1"), `session key address: ${sessionInfo.address.slice(0, 10)}...`);
  assert(sessionInfo.publicKey.length === 66, `session pubkey length: ${sessionInfo.publicKey.length}`);
  assert(sessionInfo.permissions.length === 3, "3 permissions");
  assert(sessionInfo.expiresAt > Date.now(), "expires in future");

  // Check permissions
  assert(sessionAgent.sessionHasPermission("read") === true, "has 'read' permission");
  assert(sessionAgent.sessionHasPermission("write") === false, "no 'write' permission");
  assert(sessionAgent.sessionHasPermission("query") === true, "has 'query' permission");

  // Wildcard permission
  const wildcardAgent = new RadiantAgent();
  wildcardAgent.createWallet();
  wildcardAgent.createSessionKey(["*"], 60_000);
  assert(wildcardAgent.sessionHasPermission("anything") === true, "wildcard grants all permissions");

  // Revoke
  sessionAgent.revokeSessionKey();
  assert(sessionAgent.getSessionKey() === null, "session key revoked");
  assert(sessionAgent.sessionHasPermission("read") === false, "no permission after revoke");

  // ─── Test 18: Session Key Expiry ───
  console.log("\nTest 18: Session key expiry");
  const expiryAgent = new RadiantAgent();
  expiryAgent.createWallet();
  expiryAgent.createSessionKey(["read"], 1); // 1ms TTL
  await new Promise(r => setTimeout(r, 10)); // Wait for expiry
  assert(expiryAgent.getSessionKey() === null, "session key expired after 1ms");

  // ─── Test 19: Batch Operations (Live) ───
  console.log("\nTest 19: Batch operations (live)");
  try {
    const batchAgent = new RadiantAgent();
    batchAgent.createWallet();
    await batchAgent.connect();

    const balances = await batchAgent.getBalances([
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      batchAgent.getAddress(),
    ]);
    assert(balances.length === 2, `batch returned ${balances.length} results`);
    assert(balances[0].confirmed.photons > 0, `genesis balance > 0`);

    // Audit log should have the batch entry
    const batchLog = batchAgent.getAuditLog({ action: "batch_get_balances" });
    assert(batchLog.length === 1, "batch operation was audited");
    assert(batchLog[0].durationMs !== undefined, `batch took ${batchLog[0].durationMs}ms`);

    await batchAgent.disconnect();
  } catch (err) {
    console.error("  Batch test error:", err);
    failed++;
  }

  // ─── Test 20: Health Check (Live) ───
  console.log("\nTest 20: Health check (live)");
  try {
    const healthAgent = new RadiantAgent();
    healthAgent.createWallet();
    await healthAgent.connect();

    const health = await healthAgent.getHealthStatus();
    assert(health.connected === true, `connected = ${health.connected}`);
    assert(health.latencyMs >= 0, `latency = ${health.latencyMs}ms`);
    assert(health.network === "mainnet", `network = ${health.network}`);

    const pingMs = await healthAgent.ping();
    assert(pingMs >= 0, `ping = ${pingMs}ms`);

    await healthAgent.disconnect();
  } catch (err) {
    console.error("  Health test error:", err);
    failed++;
  }

  // ── Test 21: BIP39 mnemonic wallet generation ──
  console.log("\nTest 21: BIP39 mnemonic wallet generation");
  try {
    const { wallet: mnWallet, mnemonic, path } = AgentWallet.generateWithMnemonic("mainnet", 12);
    const words = mnemonic.split(" ");
    assert(words.length === 12, `12 words: ${words.length}`);
    assert(mnWallet.address.startsWith("1"), `mainnet address: ${mnWallet.address.slice(0, 6)}...`);
    assert(path === "m/44'/0'/0'/0/0", `default path: ${path}`);
    assert(mnWallet.getPublicKeyHex().length === 66, `pubkey length: ${mnWallet.getPublicKeyHex().length}`);

    // Verify info includes mnemonic
    const info = mnWallet.getInfo();
    assert(info.mnemonic === mnemonic, `info has mnemonic`);
    assert(info.derivationPath === path, `info has derivation path`);
  } catch (err) {
    console.error("  BIP39 generate error:", err);
    failed++;
  }

  // ── Test 22: BIP39 mnemonic restore (deterministic) ──
  console.log("\nTest 22: BIP39 mnemonic restore (deterministic)");
  try {
    const { wallet: w1, mnemonic: m1 } = AgentWallet.generateWithMnemonic("mainnet", 12);
    const w2 = AgentWallet.fromMnemonic(m1, "mainnet");
    assert(w2.address === w1.address, `restored address matches: ${w1.address.slice(0, 10)}...`);
    assert(w2.getWIF() === w1.getWIF(), `restored WIF matches`);
    assert(w2.getPublicKeyHex() === w1.getPublicKeyHex(), `restored pubkey matches`);
  } catch (err) {
    console.error("  BIP39 restore error:", err);
    failed++;
  }

  // ── Test 23: BIP39 validation ──
  console.log("\nTest 23: BIP39 mnemonic validation");
  try {
    const { mnemonic: validMnemonic } = AgentWallet.generateWithMnemonic("mainnet", 12);
    assert(AgentWallet.validateMnemonic(validMnemonic) === true, `valid mnemonic accepted`);
    assert(AgentWallet.validateMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about") === true, `test vector accepted`);
    assert(AgentWallet.validateMnemonic("invalid words that are not a real mnemonic at all ever") === false, `invalid mnemonic rejected`);
    assert(AgentWallet.validateMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon") === false, `bad checksum rejected`);
  } catch (err) {
    console.error("  BIP39 validation error:", err);
    failed++;
  }

  // ── Test 24: BIP39 24-word mnemonic ──
  console.log("\nTest 24: BIP39 24-word mnemonic");
  try {
    const { wallet: w24, mnemonic: m24 } = AgentWallet.generateWithMnemonic("mainnet", 24);
    const words24 = m24.split(" ");
    assert(words24.length === 24, `24 words: ${words24.length}`);
    assert(w24.address.startsWith("1"), `address valid: ${w24.address.slice(0, 6)}...`);

    // Restore with passphrase produces different address
    const wPass = AgentWallet.fromMnemonic(m24, "mainnet", "mysecret");
    assert(wPass.address !== w24.address, `passphrase changes derivation`);
  } catch (err) {
    console.error("  BIP39 24-word error:", err);
    failed++;
  }

  // ── Test 25: BIP39 different derivation paths ──
  console.log("\nTest 25: BIP39 different derivation paths");
  try {
    const { mnemonic: mPath } = AgentWallet.generateWithMnemonic("mainnet", 12);
    const w0 = AgentWallet.fromMnemonic(mPath, "mainnet", "", "m/44'/0'/0'/0/0");
    const w1 = AgentWallet.fromMnemonic(mPath, "mainnet", "", "m/44'/0'/0'/0/1");
    assert(w0.address !== w1.address, `index 0 ≠ index 1`);

    // Same path = same address
    const w0again = AgentWallet.fromMnemonic(mPath, "mainnet", "", "m/44'/0'/0'/0/0");
    assert(w0.address === w0again.address, `same path = same address`);
  } catch (err) {
    console.error("  BIP39 path error:", err);
    failed++;
  }

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Agent SDK Test Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Agent test crashed:", err);
  process.exit(1);
});
