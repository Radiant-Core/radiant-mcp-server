/**
 * Compiler integration test.
 * Tests the radiant_compile_script tool via the compiler module.
 * Requires rxdc binary available (set RXDC_PATH or have RadiantScript as sibling repo).
 */

import { compileScript, checkCompilerAvailable } from "../src/compiler.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

// Multi-function contract for testing (correct RadiantScript syntax)
const SIMPLE_CONTRACT = `
contract TransferWithTimeout(
    pubkey sender,
    pubkey recipient,
    int timeout
) {
    return {
        transfer(sig recipientSig) {
            require(checkSig(recipientSig, recipient));
        },

        timeout(sig senderSig) {
            require(checkSig(senderSig, sender));
            require(tx.time >= timeout);
        }
    }
}
`;

// Invalid contract to test error handling
const INVALID_CONTRACT = `
contract Broken() {
    return {
        bad() {
            require(undefinedVariable == 1);
        }
    }
}`;

// Minimal single-function contract (P2PKH style)
const MINIMAL_CONTRACT = `
contract P2PKH(bytes20 pkh) {
    return {
        spend(sig s, pubkey pk) {
            require(hash160(pk) == pkh);
            require(checkSig(s, pk));
        }
    }
}`;

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log(" Compiler Integration Tests");
  console.log("═══════════════════════════════════════════════\n");

  // ── Compiler availability ──────────────────────────────
  console.log("── Compiler Availability ──");
  const binaryPath = await checkCompilerAvailable();
  if (!binaryPath) {
    console.log("  ⚠️  rxdc compiler not found — skipping compiler tests");
    console.log("  Set RXDC_PATH env var or ensure RadiantScript repo is a sibling directory.\n");
    console.log(`\n${passed} passed, ${failed} failed (compiler not available — tests skipped)`);
    process.exit(0);
  }
  assert(binaryPath !== null, `Compiler found at: ${binaryPath}`);

  // ── Artifact format compilation ────────────────────────
  console.log("\n── Artifact Format ──");
  const artifactResult = await compileScript(SIMPLE_CONTRACT, { format: "artifact" });
  assert(artifactResult.success === true, "Simple contract compiles successfully");

  if (artifactResult.success) {
    assert(artifactResult.artifact !== undefined, "Artifact object returned");
    assert(artifactResult.artifact!.contract === "TransferWithTimeout", "Contract name is correct");
    assert(artifactResult.artifact!.abi.length >= 2, "ABI has at least 2 entries (2 functions)");

    const transferFn = artifactResult.artifact!.abi.find(f => f.name === "transfer");
    assert(transferFn !== undefined, "ABI contains 'transfer' function");
    assert(transferFn?.type === "function", "transfer is type 'function'");

    const timeoutFn = artifactResult.artifact!.abi.find(f => f.name === "timeout");
    assert(timeoutFn !== undefined, "ABI contains 'timeout' function");

    const constructorFn = artifactResult.artifact!.abi.find(f => f.type === "constructor");
    assert(constructorFn !== undefined, "ABI contains constructor");
    assert(constructorFn?.params.length === 3, "Constructor has 3 params (sender, recipient, timeout)");

    assert(typeof artifactResult.artifact!.asm === "string", "ASM is a string");
    assert(artifactResult.artifact!.asm.length > 0, "ASM is non-empty");
    assert(artifactResult.artifact!.version === 9, "Artifact version is 9");
    assert(artifactResult.artifact!.compilerVersion.startsWith("rxdc"), "Compiler version starts with 'rxdc'");
  }

  // ── ASM format compilation ─────────────────────────────
  console.log("\n── ASM Format ──");
  const asmResult = await compileScript(SIMPLE_CONTRACT, { format: "asm" });
  assert(asmResult.success === true, "ASM format compilation succeeds");
  if (asmResult.success) {
    assert(typeof asmResult.asm === "string", "ASM string returned");
    assert(asmResult.asm!.includes("OP_CHECKSIG"), "ASM contains OP_CHECKSIG");
    assert(asmResult.asm!.includes("OP_CHECKLOCKTIMEVERIFY"), "ASM contains OP_CHECKLOCKTIMEVERIFY");
  }

  // ── Hex format compilation ─────────────────────────────
  console.log("\n── Hex Format ──");
  const hexResult = await compileScript(SIMPLE_CONTRACT, { format: "hex" });
  assert(hexResult.success === true, "Hex format compilation succeeds");
  if (hexResult.success) {
    assert(typeof hexResult.hex === "string", "Hex string returned");
    assert(/^[0-9a-f<>a-z_]+$/i.test(hexResult.hex!), "Hex output is valid hex (with placeholders)");
  }

  // ── Debug mode ─────────────────────────────────────────
  console.log("\n── Debug Mode ──");
  const debugResult = await compileScript(SIMPLE_CONTRACT, { format: "artifact", debug: true });
  assert(debugResult.success === true, "Debug compilation succeeds");
  if (debugResult.success && debugResult.artifact) {
    assert(debugResult.artifact.source !== undefined, "Debug artifact includes source");
    assert(debugResult.artifact.sourceMap !== undefined, "Debug artifact includes sourceMap");
  }

  // ── Minimal contract ───────────────────────────────────
  console.log("\n── Minimal Contract ──");
  const minResult = await compileScript(MINIMAL_CONTRACT, { format: "artifact" });
  assert(minResult.success === true, "Minimal contract compiles");
  if (minResult.success && minResult.artifact) {
    assert(minResult.artifact.contract === "P2PKH", "Contract name is 'P2PKH'");
    const spendFn = minResult.artifact.abi.find(f => f.name === "spend");
    assert(spendFn !== undefined, "ABI contains 'spend' function");
    assert(minResult.artifact.asm.includes("OP_CHECKSIG"), "P2PKH ASM includes OP_CHECKSIG");
  }

  // ── Error handling ─────────────────────────────────────
  console.log("\n── Error Handling ──");
  const errResult = await compileScript(INVALID_CONTRACT);
  assert(errResult.success === false, "Invalid contract fails compilation");
  if (!errResult.success) {
    assert(typeof errResult.error === "string", "Error message is a string");
    assert(errResult.error.length > 0, "Error message is non-empty");
  }

  const emptyResult = await compileScript("");
  assert(emptyResult.success === false, "Empty source fails compilation");

  const garbageResult = await compileScript("not a contract at all!!!");
  assert(garbageResult.success === false, "Garbage input fails compilation");

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
