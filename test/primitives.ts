/**
 * Phase 5: On-Chain AI Primitives test.
 * Tests inference proofs, agent identity, payment channels, and data marketplace helpers.
 */

import {
  createInferenceProof,
  verifyInferenceProof,
  buildAgentProfile,
  buildAgentWaveRecords,
  parseAgentCapabilities,
  openChannel,
  updateChannel,
  channelSummary,
  buildDataAssetMetadata,
  computeProvenanceCommitment,
} from "../src/primitives.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

async function main() {
  // ═══════════════════════════════════════════════
  // 5.1 Inference Proofs
  // ═══════════════════════════════════════════════
  console.log("Test 5.1: Inference Proofs");

  const modelHash = "a".repeat(64);
  const inputHash = "b".repeat(64);
  const output = Buffer.from("The answer is 42", "utf-8");

  const proof = createInferenceProof(modelHash, inputHash, output);
  assert(proof.modelHash === modelHash, `modelHash preserved`);
  assert(proof.inputHash === inputHash, `inputHash preserved`);
  assert(proof.commitment.length === 64, `commitment is 32 bytes hex: ${proof.commitment.slice(0, 16)}...`);
  assert(proof.timestamp > 0, `timestamp set: ${proof.timestamp}`);

  // Verification
  const valid = verifyInferenceProof(modelHash, inputHash, output, proof.commitment);
  assert(valid === true, "proof verifies correctly");

  const invalid = verifyInferenceProof(modelHash, inputHash, Buffer.from("wrong"), proof.commitment);
  assert(invalid === false, "tampered output fails verification");

  const wrongModel = verifyInferenceProof("c".repeat(64), inputHash, output, proof.commitment);
  assert(wrongModel === false, "wrong model hash fails verification");

  // Deterministic
  const proof2 = createInferenceProof(modelHash, inputHash, output);
  assert(proof.commitment === proof2.commitment, "same inputs produce same commitment");

  // ═══════════════════════════════════════════════
  // 5.2 Agent Identity
  // ═══════════════════════════════════════════════
  console.log("\nTest 5.2: Agent Identity");

  const profile = buildAgentProfile({
    address: "1AgentAddress123456789",
    description: "AI research assistant powered by GPT-4",
    apiUrl: "https://api.myagent.com/v1",
    capabilities: ["research", "summarize", "translate", "code"],
    pricing: "100sat/query",
    model: "gpt-4-turbo",
  });

  assert(profile.profileCommitment!.length === 64, `profile commitment: ${profile.profileCommitment!.slice(0, 16)}...`);
  assert(profile.capabilities.length === 4, "4 capabilities");
  assert(profile.address === "1AgentAddress123456789", "address preserved");

  // WAVE records
  const records = buildAgentWaveRecords(profile);
  assert(records.address === "1AgentAddress123456789", "WAVE address record");
  assert(records["x-capabilities"] === "research,summarize,translate,code", "WAVE capabilities");
  assert(records["x-pricing"] === "100sat/query", "WAVE pricing");
  assert(records["x-model"] === "gpt-4-turbo", "WAVE model");
  assert(records.url === "https://api.myagent.com/v1", "WAVE URL");

  // Parse capabilities from zone records
  const parsed = parseAgentCapabilities(records as Record<string, unknown>);
  assert(parsed !== null, "parsed profile not null");
  assert(parsed!.capabilities.length === 4, "parsed 4 capabilities");
  assert(parsed!.pricing === "100sat/query", "parsed pricing");

  // Null handling
  const nullParsed = parseAgentCapabilities({});
  assert(nullParsed === null, "null zone returns null profile");

  // ═══════════════════════════════════════════════
  // 5.4 Micropayment Channels
  // ═══════════════════════════════════════════════
  console.log("\nTest 5.4: Micropayment Channels");

  const agentA = "02" + "a".repeat(64);
  const agentB = "03" + "b".repeat(64);

  // Open channel with 10 RXD capacity
  const ch = openChannel("tx123abc", agentA, agentB, 10_00000000);
  assert(ch.capacity === 10_00000000, `capacity = ${satoshisToRxd(ch.capacity)} RXD`);
  assert(ch.balanceA === 10_00000000, "agentA starts with full balance");
  assert(ch.balanceB === 0, "agentB starts with 0");
  assert(ch.nonce === 0, "initial nonce = 0");
  assert(ch.stateCommitment.length === 64, `state commitment: ${ch.stateCommitment.slice(0, 16)}...`);

  // Payment: A pays B 1 RXD
  const ch2 = updateChannel(ch, 1_00000000);
  assert(ch2.balanceA === 9_00000000, `agentA = ${satoshisToRxd(ch2.balanceA)} RXD`);
  assert(ch2.balanceB === 1_00000000, `agentB = ${satoshisToRxd(ch2.balanceB)} RXD`);
  assert(ch2.nonce === 1, "nonce incremented to 1");
  assert(ch2.stateCommitment !== ch.stateCommitment, "commitment changed");

  // Multiple payments
  let state = ch2;
  for (let i = 0; i < 5; i++) {
    state = updateChannel(state, 50000000); // 0.5 RXD each
  }
  assert(state.balanceA === 6_50000000, `after 5 payments: agentA = ${satoshisToRxd(state.balanceA)} RXD`);
  assert(state.balanceB === 3_50000000, `after 5 payments: agentB = ${satoshisToRxd(state.balanceB)} RXD`);
  assert(state.nonce === 6, `nonce = ${state.nonce}`);

  // Overdraft prevention
  let overdraftError = false;
  try { updateChannel(state, 7_00000000); } catch { overdraftError = true; }
  assert(overdraftError, "overdraft prevented");

  // Channel summary
  const summary = channelSummary(state);
  assert(summary.includes("Capacity: 10.00000000 RXD"), "summary shows capacity");
  assert(summary.includes("Nonce: 6"), "summary shows nonce");

  // ═══════════════════════════════════════════════
  // 5.5 Data Marketplace
  // ═══════════════════════════════════════════════
  console.log("\nTest 5.5: Data Marketplace");

  const metadata = buildDataAssetMetadata({
    ref: "abc123_0",
    type: "dataset",
    name: "ImageNet-Radiant Subset",
    description: "Curated image classification dataset for on-chain AI",
    contentHash: "d".repeat(64),
    sizeBytes: 1024 * 1024 * 500, // 500 MB
    mimeType: "application/tar+gzip",
    price: 100_00000000, // 100 RXD
    derivedFrom: ["parent1_0", "parent2_0"],
    license: "CC-BY-4.0",
  });

  assert(metadata.v === 2, "Glyph v2");
  assert((metadata.p as number[]).includes(2), "protocol includes NFT");
  assert((metadata.p as number[]).includes(3), "protocol includes DAT");
  assert(metadata.name === "ImageNet-Radiant Subset", "name preserved");
  assert(metadata["x-type"] === "dataset", "type = dataset");
  assert(metadata["x-content-hash"] === "d".repeat(64), "content hash");
  assert(metadata["x-price"] === 100_00000000, "price = 100 RXD");
  assert((metadata["x-derived-from"] as string[]).length === 2, "2 parent refs");
  assert(metadata["x-license"] === "CC-BY-4.0", "license");

  // Provenance commitment
  const parentHashes = ["a".repeat(64), "b".repeat(64)];
  const commitment = computeProvenanceCommitment(parentHashes, "resized and relabeled");
  assert(commitment.length === 64, `provenance commitment: ${commitment.slice(0, 16)}...`);

  // Deterministic
  const commitment2 = computeProvenanceCommitment(parentHashes, "resized and relabeled");
  assert(commitment === commitment2, "provenance commitment is deterministic");

  // Different transform = different commitment
  const commitment3 = computeProvenanceCommitment(parentHashes, "different transform");
  assert(commitment3 !== commitment, "different transform produces different commitment");

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Phase 5 Primitives Test: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}`);

  process.exit(failed > 0 ? 1 : 0);
}

function satoshisToRxd(s: number): string {
  return (s / 100_000_000).toFixed(8);
}

main().catch((err) => {
  console.error("Primitives test crashed:", err);
  process.exit(1);
});
