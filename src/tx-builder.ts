/**
 * Transaction builder for Radiant blockchain.
 *
 * Provides coin selection, P2PKH transaction construction, Glyph token
 * minting (FT + NFT), and token transfer via radiantjs.
 *
 * Security model:
 *   - Private keys are accepted as WIF strings, used transiently, never stored.
 *   - All signing happens in-process; keys are not logged.
 *   - Callers are responsible for securing key material.
 *
 * Glyph 2-transaction mint pattern:
 *   1. Commit tx  — OP_FALSE OP_RETURN <gly> <v2> <flags> <commitHash>
 *   2. Reveal tx  — OP_FALSE OP_RETURN <gly> <v2> <IS_REVEAL> <metadataJSON>
 *      The token reference = revealTxid_0 (vout 0 of reveal tx).
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { ElectrumxClient } from "./electrumx.js";

const require = createRequire(import.meta.url);
const radiantjs = require("../../radiantjs-master/index.js");

const { Transaction, PrivateKey, Script, Address, Networks } = radiantjs;
const { encodeRevealEnvelope, computeCommitHash, encodeCommitEnvelope } = radiantjs.Glyph;
const { buildRevealScript } = radiantjs.Glyph.encoder;

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** Minimum relay fee: 1 sat/byte (conservative). */
const FEE_PER_BYTE = 1;

/** Minimum output value (dust threshold). */
const DUST_SATOSHIS = 546;

/** Typical P2PKH input size in bytes (outpoint 36 + script 107 + seq 4 = 147). */
const P2PKH_INPUT_SIZE = 148;

/** Typical P2PKH output size in bytes (value 8 + script 25 + varint 1 = 34). */
const P2PKH_OUTPUT_SIZE = 34;

/** OP_RETURN output overhead (value 8 + varint 1). */
const OP_RETURN_OVERHEAD = 9;

/** Transaction overhead (version 4 + locktime 4 + input/output varints ~2). */
const TX_OVERHEAD = 10;

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface RawUTXO {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

export interface BuildResult {
  txid: string;
  rawTx: string;
  fee: number;
  inputCount: number;
  outputCount: number;
}

export interface SendRxdParams {
  wif: string;
  toAddress: string;
  satoshis: number;
  changeAddress?: string;
  feePerByte?: number;
}

export interface GlyphMetadata {
  /** Protocol IDs: 1=FT, 2=NFT, 3=DAT, etc. */
  p: number[];
  /** Token name */
  name?: string;
  /** Token description */
  desc?: string;
  /** Token ticker symbol (FT) */
  ticker?: string;
  /** Decimal places (FT, default 8) */
  decimals?: number;
  /** Total supply in base units (FT) */
  supply?: number;
  /** Image URL or IPFS CID */
  image?: string;
  /** Arbitrary extra fields */
  [key: string]: unknown;
}

export interface CreateFtParams {
  wif: string;
  changeAddress?: string;
  metadata: GlyphMetadata;
  /** Total supply in base units */
  supply: number;
  feePerByte?: number;
}

export interface CreateNftParams {
  wif: string;
  changeAddress?: string;
  metadata: GlyphMetadata;
  feePerByte?: number;
}

export interface TransferTokenParams {
  wif: string;
  toAddress: string;
  /** Token reference in txid_vout format (e.g. "abc123_0") */
  tokenRef: string;
  /** Amount in base units (FT) or 1 (NFT) */
  amount: number;
  changeAddress?: string;
  feePerByte?: number;
}

export interface TokenUtxo {
  /** Token reference in txid_vout format */
  tokenRef: string;
  txid: string;
  vout: number;
  height: number;
  /** UTXO value in satoshis (carries the token) */
  satoshis: number;
}

export interface TokenUtxoResult {
  address: string;
  tokens: TokenUtxo[];
  /** Raw UTXO set for the address (all UTXOs, not just token-bearing ones) */
  allUtxos: RawUTXO[];
}

export interface BuildTxOutput {
  address: string;
  satoshis: number;
}

export interface BuildTransactionParams {
  wif: string;
  outputs: BuildTxOutput[];
  changeAddress?: string;
  feePerByte?: number;
  /** If true, build and sign but do NOT broadcast. Returns rawTx hex only. */
  dryRun?: boolean;
}

export interface DryRunResult {
  txid: string;
  rawTx: string;
  fee: number;
  feeSatoshis: number;
  sizeBytes: number;
  inputCount: number;
  outputCount: number;
  inputs: Array<{ txid: string; vout: number; value: number }>;
  outputs: Array<{ address?: string; satoshis: number }>;
  broadcasted: false;
}

export interface EstimateFeeParams {
  /** Number of inputs (P2PKH) */
  inputCount: number;
  /** Number of P2PKH outputs */
  outputCount: number;
  /** Sizes of any OP_RETURN data payloads in bytes */
  opReturnSizes?: number[];
  feePerByte?: number;
}

export interface EstimateFeeResult {
  estimatedBytes: number;
  feePerByte: number;
  feeSatoshis: number;
  feeRxd: string;
}

export interface SendBatchParams {
  wif: string;
  outputs: BuildTxOutput[];
  changeAddress?: string;
  feePerByte?: number;
}

export interface BurnTokenParams {
  wif: string;
  /** Token reference in txid_vout format */
  tokenRef: string;
  /** Amount to burn in base units (use full balance for NFT) */
  amount: number;
  changeAddress?: string;
  feePerByte?: number;
}

export interface MintResult {
  commitTxid: string;
  commitRawTx: string;
  revealTxid: string;
  revealRawTx: string;
  tokenRef: string;
  commitFee: number;
  revealFee: number;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Build a P2PKH scriptPubKey for an address (pure Buffer, no radiantjs dependency).
 */
function p2pkhScript(address: string): Buffer {
  // Use radiantjs Script.fromAddress for correctness
  return Script.fromAddress(new Address(address)).toBuffer() as Buffer;
}

/**
 * Estimate transaction size in bytes.
 */
function estimateTxSize(
  inputCount: number,
  outputCount: number,
  opReturnSizes: number[] = [],
): number {
  let size = TX_OVERHEAD;
  size += inputCount * P2PKH_INPUT_SIZE;
  size += outputCount * P2PKH_OUTPUT_SIZE;
  for (const s of opReturnSizes) {
    size += OP_RETURN_OVERHEAD + s;
  }
  return size;
}

/**
 * Simple largest-first coin selection.
 * Returns selected UTXOs and total selected value.
 */
function selectCoins(
  utxos: RawUTXO[],
  targetSatoshis: number,
  feePerByte: number,
  outputCount: number,
  opReturnSizes: number[] = [],
): { selected: RawUTXO[]; totalIn: number } {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: RawUTXO[] = [];
  let totalIn = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalIn += utxo.value;
    const fee = estimateTxSize(selected.length, outputCount + 1, opReturnSizes) * feePerByte;
    if (totalIn >= targetSatoshis + fee) break;
  }

  const fee = estimateTxSize(selected.length, outputCount + 1, opReturnSizes) * feePerByte;
  if (totalIn < targetSatoshis + fee) {
    throw new Error(
      `Insufficient funds: need ${targetSatoshis + fee} satoshis, have ${totalIn}`,
    );
  }

  return { selected, totalIn };
}

/**
 * Build and sign a P2PKH transaction.
 * Returns the signed raw hex and txid.
 */
function buildAndSign(
  utxos: RawUTXO[],
  fromAddress: string,
  outputs: Array<{ address?: string; script?: Buffer; satoshis: number }>,
  changeAddress: string,
  wif: string,
  feePerByte: number,
): BuildResult {
  const privKey = new PrivateKey(wif);
  const scriptPubKey = p2pkhScript(fromAddress).toString("hex");

  const tx = new Transaction();

  // Add inputs
  for (const utxo of utxos) {
    tx.from({
      txId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: scriptPubKey,
      satoshis: utxo.value,
    });
  }

  // Add outputs
  for (const out of outputs) {
    if (out.address) {
      tx.to(out.address, out.satoshis);
    } else if (out.script) {
      const { Output } = radiantjs.Transaction;
      tx.addOutput(
        new Output({
          script: Script.fromBuffer(out.script),
          satoshis: out.satoshis,
        }),
      );
    }
  }

  // Set change address and fee rate
  tx.change(changeAddress);
  tx.feePerKb(feePerByte * 1000);

  // Sign all inputs
  tx.sign(privKey);

  const rawTx = tx.serialize({ disableIsFullySigned: false }) as string;
  const fee = Number(tx.getFee());

  return {
    txid: tx.id as string,
    rawTx,
    fee,
    inputCount: utxos.length,
    outputCount: tx.outputs.length,
  };
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Send RXD to an address.
 * Fetches UTXOs, selects coins, builds, signs, and broadcasts.
 */
export async function sendRxd(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: SendRxdParams,
): Promise<BuildResult & { broadcasted: boolean }> {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;

  const utxos = await electrumx.listUnspent(addressToScripthash(fromAddress));
  if (!utxos.length) throw new Error("No UTXOs available");

  const { selected } = selectCoins(
    utxos as RawUTXO[],
    params.satoshis,
    feePerByte,
    1,
  );

  const result = buildAndSign(
    selected,
    fromAddress,
    [{ address: params.toAddress, satoshis: params.satoshis }],
    changeAddress,
    params.wif,
    feePerByte,
  );

  const txid = await electrumx.broadcastTransaction(result.rawTx);
  return { ...result, txid: txid as string, broadcasted: true };
}

/**
 * Mint a Glyph Fungible Token (2-transaction commit+reveal pattern).
 *
 * Commit tx: OP_FALSE OP_RETURN <gly> <v2> <0x00> <commitHash32>
 * Reveal tx: OP_FALSE OP_RETURN <gly> <v2> <IS_REVEAL> <metadataJSON>
 *   + P2PKH output at vout 0 carrying the token value
 *
 * Token reference = revealTxid_0
 */
export async function createFungibleToken(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: CreateFtParams,
): Promise<MintResult> {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;

  // Ensure protocol 1 (FT) is set
  const protocols = params.metadata.p?.includes(1)
    ? params.metadata.p
    : [1, ...(params.metadata.p ?? [])];
  const metadata: GlyphMetadata = {
    v: 2,
    decimals: 8,
    ...params.metadata,
    p: protocols,
  };

  // ── Step 1: Build commit transaction ──────────────────────
  const metadataBytes = Buffer.from(JSON.stringify(canonicalize(metadata)), "utf8");
  const commitHash = computeCommitHash(metadataBytes) as Buffer;

  const commitEnvelopeData = encodeCommitEnvelope({ commitHash }) as Buffer;
  const commitScript = buildOpReturnScript([commitEnvelopeData]);
  const commitOpReturnSize = commitScript.length;

  const utxos1 = await electrumx.listUnspent(addressToScripthash(fromAddress));
  if (!utxos1.length) throw new Error("No UTXOs available for commit tx");

  const { selected: sel1 } = selectCoins(
    utxos1 as RawUTXO[],
    DUST_SATOSHIS,
    feePerByte,
    1,
    [commitOpReturnSize],
  );

  const commitResult = buildAndSign(
    sel1,
    fromAddress,
    [{ script: commitScript, satoshis: 0 }],
    changeAddress,
    params.wif,
    feePerByte,
  );

  const commitTxid = await electrumx.broadcastTransaction(commitResult.rawTx);

  // ── Step 2: Build reveal transaction ──────────────────────
  // Wait for commit to propagate (use change output from commit as input)
  const revealChunks = encodeRevealEnvelope({ metadata: metadataBytes }) as Buffer[];
  const revealScript = buildRevealScript(revealChunks) as Buffer;
  const revealOpReturnSize = revealScript.length;

  // Fetch fresh UTXOs (commit change should now be in mempool)
  const utxos2 = await electrumx.listUnspent(addressToScripthash(fromAddress));
  if (!utxos2.length) throw new Error("No UTXOs available for reveal tx");

  // Token output: P2PKH at vout 0 carrying supply value
  const tokenSatoshis = Math.max(params.supply, DUST_SATOSHIS);

  const { selected: sel2 } = selectCoins(
    utxos2 as RawUTXO[],
    tokenSatoshis,
    feePerByte,
    2,
    [revealOpReturnSize],
  );

  const revealResult = buildAndSign(
    sel2,
    fromAddress,
    [
      { address: fromAddress, satoshis: tokenSatoshis },
      { script: revealScript, satoshis: 0 },
    ],
    changeAddress,
    params.wif,
    feePerByte,
  );

  const revealTxid = await electrumx.broadcastTransaction(revealResult.rawTx);
  const tokenRef = `${revealTxid}_0`;

  return {
    commitTxid: commitTxid as string,
    commitRawTx: commitResult.rawTx,
    revealTxid: revealTxid as string,
    revealRawTx: revealResult.rawTx,
    tokenRef,
    commitFee: commitResult.fee,
    revealFee: revealResult.fee,
  };
}

/**
 * Mint a Glyph Non-Fungible Token (2-transaction commit+reveal pattern).
 * Same as FT but protocol ID = 2, supply = 1.
 */
export async function createNFT(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: CreateNftParams,
): Promise<MintResult> {
  return createFungibleToken(electrumx, fromAddress, {
    ...params,
    supply: 1,
    metadata: {
      ...params.metadata,
      p: [2, ...(params.metadata.p?.filter((p) => p !== 1 && p !== 2) ?? [])],
    },
  });
}

/**
 * Transfer a Glyph token (FT or NFT) to another address.
 *
 * For FTs: builds a tx spending the token UTXO and sending `amount` units
 *   to `toAddress`, with change back to sender.
 * For NFTs (amount=1): simple UTXO transfer.
 *
 * The caller must provide the token UTXO (txid_vout) and the amount.
 * The token UTXO must be in the sender's UTXO set.
 */
export async function transferToken(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: TransferTokenParams,
): Promise<BuildResult & { broadcasted: boolean }> {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;

  const [refTxid, refVoutStr] = params.tokenRef.split("_");
  const refVout = parseInt(refVoutStr ?? "0", 10);

  // Fetch UTXOs and find the token UTXO
  const allUtxos = (await electrumx.listUnspent(
    addressToScripthash(fromAddress),
  )) as RawUTXO[];

  const tokenUtxo = allUtxos.find(
    (u) => u.tx_hash === refTxid && u.tx_pos === refVout,
  );
  if (!tokenUtxo) {
    throw new Error(
      `Token UTXO ${params.tokenRef} not found in address ${fromAddress}. ` +
        `Ensure the token is at this address and confirmed.`,
    );
  }

  // Select fee-covering UTXOs (excluding the token UTXO itself if it's small)
  const feeUtxos = allUtxos.filter(
    (u) => !(u.tx_hash === refTxid && u.tx_pos === refVout),
  );

  // Estimate fee for 2 inputs (token + fee), 2 outputs (recipient + change)
  const estimatedFee = estimateTxSize(2, 2) * feePerByte;

  // If token UTXO has enough value to cover fee, use it alone
  let selectedUtxos: RawUTXO[];
  if (tokenUtxo.value >= params.amount + estimatedFee + DUST_SATOSHIS) {
    selectedUtxos = [tokenUtxo];
  } else {
    // Need additional fee-covering UTXOs
    const needed = estimatedFee + DUST_SATOSHIS;
    const { selected: feeSelected } = selectCoins(feeUtxos, needed, feePerByte, 2);
    selectedUtxos = [tokenUtxo, ...feeSelected];
  }

  const result = buildAndSign(
    selectedUtxos,
    fromAddress,
    [{ address: params.toAddress, satoshis: params.amount }],
    changeAddress,
    params.wif,
    feePerByte,
  );

  const txid = await electrumx.broadcastTransaction(result.rawTx);
  return { ...result, txid: txid as string, broadcasted: true };
}

/**
 * Discover all token UTXOs held by an address.
 *
 * Queries glyph.list_tokens for the address and cross-references with the
 * UTXO set so agents can discover what they hold without prior knowledge of
 * token references.
 *
 * Returns each token's UTXO ref + satoshi value alongside the full raw UTXO
 * list so callers can immediately proceed to transfer/burn without a second
 * round-trip.
 */
export async function getTokenUtxos(
  electrumx: ElectrumxClient,
  address: string,
): Promise<TokenUtxoResult> {
  const scripthash = addressToScripthash(address);

  const [rawTokens, rawUtxos] = await Promise.all([
    electrumx.glyphListTokens(scripthash, 500) as Promise<unknown>,
    electrumx.listUnspent(scripthash),
  ]);

  // Build a lookup map: "txid_vout" → UTXO for fast cross-reference
  const utxoMap = new Map<string, RawUTXO>();
  for (const u of rawUtxos as RawUTXO[]) {
    utxoMap.set(`${u.tx_hash}_${u.tx_pos}`, u);
  }

  // Normalise the token list — RXinDexer returns objects with a `ref` field
  const tokenList = Array.isArray(rawTokens) ? rawTokens : [];
  const tokens: TokenUtxo[] = [];

  for (const t of tokenList) {
    const ref: string = (t as Record<string, unknown>).ref as string
      || (t as Record<string, unknown>).token_ref as string
      || "";
    if (!ref) continue;

    const normalised = ref.replace(":", "_");
    const [txid, voutStr] = normalised.split("_");
    const vout = parseInt(voutStr ?? "0", 10);
    const utxo = utxoMap.get(normalised);

    tokens.push({
      tokenRef: normalised,
      txid,
      vout,
      height: utxo?.height ?? 0,
      satoshis: utxo?.value ?? 0,
    });
  }

  return { address, tokens, allUtxos: rawUtxos as RawUTXO[] };
}

/**
 * Build (and optionally sign) a transaction without broadcasting.
 *
 * When dryRun=true (default): builds, signs, returns raw hex + fee breakdown.
 * When dryRun=false: also broadcasts and returns txid.
 *
 * Useful for agents to inspect fee, size, and outputs before committing to
 * a high-value operation.
 */
export async function buildTransaction(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: BuildTransactionParams,
): Promise<DryRunResult | (BuildResult & { broadcasted: boolean })> {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;
  const dryRun = params.dryRun !== false; // default true

  if (!params.outputs.length) throw new Error("At least one output required");

  const totalOut = params.outputs.reduce((s, o) => s + o.satoshis, 0);

  const utxos = await electrumx.listUnspent(addressToScripthash(fromAddress));
  if (!(utxos as RawUTXO[]).length) throw new Error("No UTXOs available");

  const { selected } = selectCoins(
    utxos as RawUTXO[],
    totalOut,
    feePerByte,
    params.outputs.length,
  );

  const result = buildAndSign(
    selected,
    fromAddress,
    params.outputs.map((o) => ({ address: o.address, satoshis: o.satoshis })),
    changeAddress,
    params.wif,
    feePerByte,
  );

  const sizeBytes = Math.ceil(result.rawTx.length / 2);

  if (dryRun) {
    return {
      txid: result.txid,
      rawTx: result.rawTx,
      fee: result.fee,
      feeSatoshis: result.fee,
      sizeBytes,
      inputCount: result.inputCount,
      outputCount: result.outputCount,
      inputs: selected.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value })),
      outputs: params.outputs,
      broadcasted: false,
    };
  }

  const txid = await electrumx.broadcastTransaction(result.rawTx);
  return { ...result, txid: txid as string, broadcasted: true };
}

/**
 * Estimate transaction fee without building a real transaction.
 *
 * Pure arithmetic — no network call required.
 */
export function estimateTxFee(params: EstimateFeeParams): EstimateFeeResult {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const estimatedBytes = estimateTxSize(
    params.inputCount,
    params.outputCount,
    params.opReturnSizes ?? [],
  );
  const feeSatoshis = estimatedBytes * feePerByte;
  const feeRxd = (feeSatoshis / 1e8).toFixed(8);
  return { estimatedBytes, feePerByte, feeSatoshis, feeRxd };
}

/**
 * Send RXD to multiple recipients in a single transaction (batch/fan-out).
 *
 * Significantly cheaper than N separate transactions because inputs are
 * selected once and change is returned in a single output.
 */
export async function sendBatch(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: SendBatchParams,
): Promise<BuildResult & { broadcasted: boolean }> {
  if (!params.outputs.length) throw new Error("At least one output required");

  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;
  const totalOut = params.outputs.reduce((s, o) => s + o.satoshis, 0);

  const utxos = await electrumx.listUnspent(addressToScripthash(fromAddress));
  if (!(utxos as RawUTXO[]).length) throw new Error("No UTXOs available");

  const { selected } = selectCoins(
    utxos as RawUTXO[],
    totalOut,
    feePerByte,
    params.outputs.length,
  );

  const result = buildAndSign(
    selected,
    fromAddress,
    params.outputs.map((o) => ({ address: o.address, satoshis: o.satoshis })),
    changeAddress,
    params.wif,
    feePerByte,
  );

  const txid = await electrumx.broadcastTransaction(result.rawTx);
  return { ...result, txid: txid as string, broadcasted: true };
}

/**
 * Burn a Glyph token (protocol 6 — explicit burn).
 *
 * Builds a transaction that spends the token UTXO and sends it to an
 * OP_FALSE OP_RETURN output (unspendable), permanently destroying the token.
 * The Glyph envelope carries protocol ID 6 (BURN) as the action marker.
 *
 * A separate fee-covering UTXO is used if the token UTXO value is insufficient.
 */
export async function burnToken(
  electrumx: ElectrumxClient,
  fromAddress: string,
  params: BurnTokenParams,
): Promise<BuildResult & { broadcasted: boolean; burnScript: string }> {
  const feePerByte = params.feePerByte ?? FEE_PER_BYTE;
  const changeAddress = params.changeAddress ?? fromAddress;

  const [refTxid, refVoutStr] = params.tokenRef.split("_");
  const refVout = parseInt(refVoutStr ?? "0", 10);

  const allUtxos = (await electrumx.listUnspent(
    addressToScripthash(fromAddress),
  )) as RawUTXO[];

  const tokenUtxo = allUtxos.find(
    (u) => u.tx_hash === refTxid && u.tx_pos === refVout,
  );
  if (!tokenUtxo) {
    throw new Error(
      `Token UTXO ${params.tokenRef} not found at address ${fromAddress}`,
    );
  }

  // Build Glyph burn envelope: protocol 6 action marker
  const burnMetadata = Buffer.from(
    JSON.stringify({ p: [6], ref: params.tokenRef, amount: params.amount }),
    "utf8",
  );
  const burnScript = buildOpReturnScript([burnMetadata]);
  const burnScriptHex = burnScript.toString("hex");

  // Select fee-covering UTXOs (excluding token UTXO)
  const feeUtxos = allUtxos.filter(
    (u) => !(u.tx_hash === refTxid && u.tx_pos === refVout),
  );
  const estimatedFee = estimateTxSize(2, 1) * feePerByte;

  let selectedUtxos: RawUTXO[];
  if (tokenUtxo.value >= estimatedFee + DUST_SATOSHIS) {
    selectedUtxos = [tokenUtxo];
  } else {
    const needed = estimatedFee + DUST_SATOSHIS;
    const { selected: feeSelected } = selectCoins(feeUtxos, needed, feePerByte, 1);
    selectedUtxos = [tokenUtxo, ...feeSelected];
  }

  const result = buildAndSign(
    selectedUtxos,
    fromAddress,
    [{ script: burnScript, satoshis: 0 }],
    changeAddress,
    params.wif,
    feePerByte,
  );

  const txid = await electrumx.broadcastTransaction(result.rawTx);
  return { ...result, txid: txid as string, broadcasted: true, burnScript: burnScriptHex };
}

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

/**
 * Build an OP_FALSE OP_RETURN script from raw data buffers.
 */
function buildOpReturnScript(chunks: Buffer[]): Buffer {
  const script = new Script();
  script.add("OP_FALSE");
  script.add("OP_RETURN");
  for (const chunk of chunks) {
    script.add(chunk);
  }
  return script.toBuffer() as Buffer;
}

/**
 * Recursively sort object keys for canonical JSON encoding.
 */
function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Convert a Radiant address to ElectrumX scripthash.
 * Duplicated here to avoid circular imports.
 */
function addressToScripthash(address: string): string {
  const addr = new Address(address);
  const script = Script.fromAddress(addr).toBuffer() as Buffer;
  const hash = createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}
