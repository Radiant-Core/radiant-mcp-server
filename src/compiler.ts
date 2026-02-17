/**
 * RadiantScript compiler integration — wraps the `rxdc` CLI to compile
 * .cash/.rxd source code into artifacts (ABI + bytecode ASM).
 *
 * The compiler binary is resolved in order:
 *   1. RXDC_PATH environment variable
 *   2. `rxdc` on $PATH
 *   3. Sibling RadiantScript repo: ../RadiantScript-radiantscript/node_modules/.bin/rxdc
 *
 * This is an offline operation — no ElectrumX connection required.
 */

import { execFile } from "node:child_process";
import { writeFile, unlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface AbiParam {
  name: string;
  type: string;
}

export interface AbiFunction {
  type: "function" | "constructor";
  name?: string;
  index?: number;
  params: AbiParam[];
}

export interface CompileArtifact {
  version: number;
  compilerVersion: string;
  contract: string;
  abi: AbiFunction[];
  asm: string;
  hex?: string;
  source?: string;
  sourceMap?: Record<string, unknown>;
}

export interface CompileResult {
  success: true;
  artifact?: CompileArtifact;
  asm?: string;
  hex?: string;
  warnings: string[];
}

export interface CompileError {
  success: false;
  error: string;
  details?: string;
}

export interface CompileOptions {
  /** Output format: full artifact JSON, ASM text, or hex bytecode */
  format?: "artifact" | "asm" | "hex";
  /** Include source + source map in artifact for debugging with rxdeb */
  debug?: boolean;
}

// ────────────────────────────────────────────────────────────
// Binary resolution
// ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Well-known sibling paths relative to this repo's src/ or dist/ directory */
const SIBLING_PATHS = [
  resolve(__dirname, "../../RadiantScript-radiantscript/node_modules/.bin/rxdc"),
  resolve(__dirname, "../../../RadiantScript-radiantscript/node_modules/.bin/rxdc"),
];

let resolvedBinary: string | null = null;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err, stdout) => {
      if (err || !stdout.trim()) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

async function resolveRxdc(): Promise<string> {
  if (resolvedBinary) return resolvedBinary;

  // 1. Env var
  if (process.env.RXDC_PATH) {
    if (await fileExists(process.env.RXDC_PATH)) {
      resolvedBinary = process.env.RXDC_PATH;
      return resolvedBinary;
    }
    throw new Error(`RXDC_PATH set to '${process.env.RXDC_PATH}' but file not found`);
  }

  // 2. PATH lookup
  const onPath = await which("rxdc");
  if (onPath) {
    resolvedBinary = onPath;
    return resolvedBinary;
  }

  // 3. Sibling repo
  for (const candidate of SIBLING_PATHS) {
    if (await fileExists(candidate)) {
      resolvedBinary = candidate;
      return resolvedBinary;
    }
  }

  throw new Error(
    "rxdc compiler not found. Set RXDC_PATH env var, add rxdc to PATH, " +
    "or ensure RadiantScript repo is a sibling directory.",
  );
}

// ────────────────────────────────────────────────────────────
// Compilation
// ────────────────────────────────────────────────────────────

function runRxdc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(args[0], args.slice(1), { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function compileScript(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult | CompileError> {
  const binary = await resolveRxdc();
  const tmpFile = join(tmpdir(), `rxdc-${randomBytes(8).toString("hex")}.cash`);

  try {
    await writeFile(tmpFile, source, "utf-8");

    const args: string[] = [binary, tmpFile];
    if (options.debug) args.push("--debug");
    if (options.format === "asm") args.push("--asm");
    if (options.format === "hex") args.push("--hex");

    const { stdout, stderr } = await runRxdc(args);
    const warnings: string[] = stderr
      ? stderr.split("\n").filter((l) => l.startsWith("Warning:"))
      : [];

    if (options.format === "asm") {
      return { success: true, asm: stdout.trim(), warnings };
    }
    if (options.format === "hex") {
      return { success: true, hex: stdout.trim(), warnings };
    }

    const artifact: CompileArtifact = JSON.parse(stdout);
    return { success: true, artifact, warnings };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: "Compilation failed", details: message };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Check whether the rxdc compiler is available.
 * Returns the binary path on success, or null if not found.
 */
export async function checkCompilerAvailable(): Promise<string | null> {
  try {
    return await resolveRxdc();
  } catch {
    return null;
  }
}
