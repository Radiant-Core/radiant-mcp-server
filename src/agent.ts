#!/usr/bin/env node

/**
 * RadiantAgent — High-level SDK for AI agent workflows on Radiant.
 *
 * Features:
 * - Wallet lifecycle management (create, restore, derive addresses)
 * - Spending limits and safety controls
 * - Event-driven architecture (address monitoring via ElectrumX subscriptions)
 * - Structured balance, UTXO, token, and WAVE queries
 * - Transaction history and fee estimation
 *
 * For transaction building/signing, use radiantjs with the wallet's WIF.
 */

import { EventEmitter } from "node:events";
import { ElectrumxClient } from "./electrumx.js";
import { addressToScripthash, isValidAddress, satoshisToRxd } from "./address.js";
import { AgentWallet, type WalletInfo } from "./wallet.js";
import { NETWORK_PARAMS, GLYPH_PROTOCOLS, DMINT_ALGORITHMS } from "./references.js";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Network: mainnet or testnet. Default: mainnet */
  network?: "mainnet" | "testnet";
  /** ElectrumX connection string (ssl://host:port or tcp://host:port) */
  electrumx?: string;
  /** ElectrumX host. Default: electrumx.radiant4people.com */
  electrumxHost?: string;
  /** ElectrumX port. Default: 50012 */
  electrumxPort?: number;
  /** Use SSL. Default: true */
  electrumxSsl?: boolean;
  /** Max RXD per single transaction (in photons). 0 = unlimited */
  spendLimitPerTx?: number;
  /** Max RXD per hour (in photons). 0 = unlimited */
  spendLimitPerHour?: number;
  /** Connection timeout in ms. Default: 30000 */
  timeout?: number;
}

export interface SpendingRecord {
  timestamp: number;
  amount: number;
  txid?: string;
  description?: string;
}

export interface BalanceResult {
  address: string;
  confirmed: { photons: number; rxd: string };
  unconfirmed: { photons: number; rxd: string };
  total: { photons: number; rxd: string };
}

export interface UTXOResult {
  txid: string;
  vout: number;
  height: number;
  value: { photons: number; rxd: string };
}

export interface AgentEvent {
  type: string;
  address: string;
  timestamp: number;
  data?: unknown;
}

export type AgentEventType =
  | "balance-changed"
  | "payment-received"
  | "connected"
  | "disconnected"
  | "error"
  | "spend-limit-warning";

// ────────────────────────────────────────────────────────────
// Agent SDK
// ────────────────────────────────────────────────────────────

export class RadiantAgent extends EventEmitter {
  private readonly config: Required<Omit<AgentConfig, "electrumx">>;
  private readonly electrumx: ElectrumxClient;
  private wallet: AgentWallet | null = null;
  private connected = false;
  private readonly spendingHistory: SpendingRecord[] = [];
  private readonly watchedAddresses = new Map<string, string>(); // address → scripthash
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly lastKnownBalance = new Map<string, number>(); // scripthash → confirmed

  constructor(config: AgentConfig = {}) {
    super();

    // Parse connection string if provided
    let host = config.electrumxHost || "electrumx.radiant4people.com";
    let port = config.electrumxPort || 50012;
    let ssl = config.electrumxSsl ?? true;

    if (config.electrumx) {
      const url = new URL(config.electrumx);
      host = url.hostname;
      port = parseInt(url.port, 10);
      ssl = url.protocol === "ssl:" || url.protocol === "tls:";
    }

    this.config = {
      network: config.network || "mainnet",
      electrumxHost: host,
      electrumxPort: port,
      electrumxSsl: ssl,
      spendLimitPerTx: config.spendLimitPerTx || 0,
      spendLimitPerHour: config.spendLimitPerHour || 0,
      timeout: config.timeout || 30_000,
    };

    this.electrumx = new ElectrumxClient({
      host: this.config.electrumxHost,
      port: this.config.electrumxPort,
      ssl: this.config.electrumxSsl,
      timeout: this.config.timeout,
    });
  }

  // ══════════════════════════════════════════════════════════
  //  Connection
  // ══════════════════════════════════════════════════════════

  /** Connect to ElectrumX. Called automatically on first query if needed. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.electrumx.connect();
    await this.electrumx.serverVersion("radiant-agent-sdk/1.0.0", "1.4");
    this.connected = true;
    this.emit("connected");
  }

  /** Disconnect from ElectrumX and stop monitoring. */
  async disconnect(): Promise<void> {
    this.stopMonitoring();
    if (this.connected) {
      this.electrumx.disconnect();
      this.connected = false;
      this.emit("disconnected");
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  // ══════════════════════════════════════════════════════════
  //  Wallet Management
  // ══════════════════════════════════════════════════════════

  /** Create a new wallet with a random private key. */
  createWallet(): WalletInfo {
    this.wallet = AgentWallet.create(this.config.network);
    return this.wallet.getInfo();
  }

  /** Restore wallet from WIF-encoded private key. */
  importWallet(wif: string): WalletInfo {
    this.wallet = AgentWallet.fromWIF(wif);
    return this.wallet.getInfo();
  }

  /** Get current wallet info, or null if no wallet is loaded. */
  getWallet(): WalletInfo | null {
    return this.wallet?.getInfo() || null;
  }

  /** Get the wallet's primary address. */
  getAddress(): string {
    if (!this.wallet) throw new Error("No wallet loaded. Call createWallet() or importWallet() first.");
    return this.wallet.address;
  }

  /** Get the wallet's WIF (for use with radiantjs transaction signing). */
  getWIF(): string {
    if (!this.wallet) throw new Error("No wallet loaded");
    return this.wallet.getWIF();
  }

  /** Check if a wallet is loaded. */
  hasWallet(): boolean {
    return this.wallet !== null;
  }

  // ══════════════════════════════════════════════════════════
  //  Balance & UTXOs
  // ══════════════════════════════════════════════════════════

  /** Get RXD balance for an address (defaults to wallet address). */
  async getBalance(address?: string): Promise<BalanceResult> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    const bal = await this.electrumx.getBalance(sh);
    return {
      address: addr,
      confirmed: { photons: bal.confirmed, rxd: satoshisToRxd(bal.confirmed) },
      unconfirmed: { photons: bal.unconfirmed, rxd: satoshisToRxd(bal.unconfirmed) },
      total: {
        photons: bal.confirmed + bal.unconfirmed,
        rxd: satoshisToRxd(bal.confirmed + bal.unconfirmed),
      },
    };
  }

  /** List UTXOs for an address (defaults to wallet address). */
  async getUTXOs(address?: string): Promise<UTXOResult[]> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    const utxos = await this.electrumx.listUnspent(sh);
    return utxos.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      height: u.height,
      value: { photons: u.value, rxd: satoshisToRxd(u.value) },
    }));
  }

  /** Get transaction history for an address (defaults to wallet). */
  async getHistory(address?: string): Promise<Array<{ txid: string; height: number; confirmed: boolean }>> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    const history = await this.electrumx.getHistory(sh);
    return history.map((h) => ({
      txid: h.tx_hash,
      height: h.height,
      confirmed: h.height > 0,
    }));
  }

  // ══════════════════════════════════════════════════════════
  //  Chain Info
  // ══════════════════════════════════════════════════════════

  /** Get current chain tip. */
  async getChainTip(): Promise<{ height: number; headerHex: string }> {
    await this.ensureConnected();
    const tip = await this.electrumx.headersSubscribe();
    return { height: tip.height, headerHex: tip.hex };
  }

  /** Estimate fee in RXD per KB for target confirmation blocks. */
  async estimateFee(blocks = 6): Promise<number> {
    await this.ensureConnected();
    return this.electrumx.estimateFee(blocks);
  }

  /** Get transaction details by txid. */
  async getTransaction(txid: string): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.getTransaction(txid, true);
  }

  /** Broadcast a signed raw transaction. */
  async broadcastTransaction(rawTxHex: string): Promise<string> {
    await this.ensureConnected();
    const txid = await this.electrumx.broadcastTransaction(rawTxHex) as string;
    return txid;
  }

  // ══════════════════════════════════════════════════════════
  //  Glyph Tokens
  // ══════════════════════════════════════════════════════════

  /** List Glyph tokens held by an address (defaults to wallet). */
  async listTokens(address?: string, limit = 100): Promise<unknown> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    return this.electrumx.glyphListTokens(sh, limit);
  }

  /** Get token info by reference. */
  async getToken(ref: string): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.glyphGetTokenInfo(ref.replace(":", "_"));
  }

  /** Get token balance for an address. */
  async getTokenBalance(tokenRef: string, address?: string): Promise<unknown> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    return this.electrumx.glyphGetBalance(sh, tokenRef.replace(":", "_"));
  }

  /** Search tokens by name or ticker. */
  async searchTokens(query: string, limit = 50): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.glyphSearchTokens(query, undefined, limit);
  }

  /** Get token metadata. */
  async getTokenMetadata(ref: string): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.glyphGetMetadata(ref.replace(":", "_"));
  }

  // ══════════════════════════════════════════════════════════
  //  WAVE Names
  // ══════════════════════════════════════════════════════════

  /** Resolve a WAVE name to its zone records. */
  async resolveWaveName(name: string): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.waveResolve(name);
  }

  /** Check if a WAVE name is available. */
  async isWaveNameAvailable(name: string): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.waveCheckAvailable(name);
  }

  /** Find WAVE names owned by an address. */
  async getWaveNames(address?: string, limit = 100): Promise<unknown> {
    const addr = address || this.getAddress();
    if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
    await this.ensureConnected();
    const sh = addressToScripthash(addr);
    return this.electrumx.waveReverseLookup(sh, limit);
  }

  // ══════════════════════════════════════════════════════════
  //  dMint
  // ══════════════════════════════════════════════════════════

  /** List active dMint contracts. */
  async getDmintContracts(): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.dmintGetContracts("extended");
  }

  /** Get most profitable dMint contracts. */
  async getMostProfitableDmint(limit = 10): Promise<unknown> {
    await this.ensureConnected();
    return this.electrumx.dmintGetMostProfitable(limit);
  }

  // ══════════════════════════════════════════════════════════
  //  Spending Limits
  // ══════════════════════════════════════════════════════════

  /** Check if a spend amount is within configured limits. */
  checkSpendLimit(amountPhotons: number): { allowed: boolean; reason?: string } {
    // Per-transaction limit
    if (this.config.spendLimitPerTx > 0 && amountPhotons > this.config.spendLimitPerTx) {
      return {
        allowed: false,
        reason: `Amount ${satoshisToRxd(amountPhotons)} RXD exceeds per-transaction limit of ${satoshisToRxd(this.config.spendLimitPerTx)} RXD`,
      };
    }

    // Hourly limit
    if (this.config.spendLimitPerHour > 0) {
      const oneHourAgo = Date.now() - 3600_000;
      const recentSpending = this.spendingHistory
        .filter((r) => r.timestamp > oneHourAgo)
        .reduce((sum, r) => sum + r.amount, 0);
      if (recentSpending + amountPhotons > this.config.spendLimitPerHour) {
        return {
          allowed: false,
          reason: `Would exceed hourly limit of ${satoshisToRxd(this.config.spendLimitPerHour)} RXD. Already spent ${satoshisToRxd(recentSpending)} RXD in the last hour.`,
        };
      }
    }

    return { allowed: true };
  }

  /** Record a spend (call after successful broadcast). */
  recordSpend(amountPhotons: number, txid?: string, description?: string): void {
    this.spendingHistory.push({
      timestamp: Date.now(),
      amount: amountPhotons,
      txid,
      description,
    });

    // Warn at 80% of hourly limit
    if (this.config.spendLimitPerHour > 0) {
      const oneHourAgo = Date.now() - 3600_000;
      const recent = this.spendingHistory
        .filter((r) => r.timestamp > oneHourAgo)
        .reduce((sum, r) => sum + r.amount, 0);
      if (recent > this.config.spendLimitPerHour * 0.8) {
        this.emit("spend-limit-warning", {
          type: "spend-limit-warning",
          spent: recent,
          limit: this.config.spendLimitPerHour,
          percentUsed: Math.round((recent / this.config.spendLimitPerHour) * 100),
        });
      }
    }
  }

  /** Get spending history within a time window (default: last hour). */
  getSpendingHistory(sinceMs?: number): SpendingRecord[] {
    const since = sinceMs || Date.now() - 3600_000;
    return this.spendingHistory.filter((r) => r.timestamp > since);
  }

  /** Get total spent in the last hour. */
  getHourlySpending(): { photons: number; rxd: string } {
    const oneHourAgo = Date.now() - 3600_000;
    const total = this.spendingHistory
      .filter((r) => r.timestamp > oneHourAgo)
      .reduce((sum, r) => sum + r.amount, 0);
    return { photons: total, rxd: satoshisToRxd(total) };
  }

  // ══════════════════════════════════════════════════════════
  //  Address Monitoring (Event-Driven)
  // ══════════════════════════════════════════════════════════

  /** Start watching an address for balance changes. */
  watchAddress(address: string): void {
    if (!isValidAddress(address)) throw new Error(`Invalid address: ${address}`);
    const sh = addressToScripthash(address);
    this.watchedAddresses.set(address, sh);
  }

  /** Stop watching an address. */
  unwatchAddress(address: string): void {
    this.watchedAddresses.delete(address);
  }

  /** Start polling for balance changes (every intervalMs). */
  startMonitoring(intervalMs = 30_000): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.pollBalances(), intervalMs);
    // Also poll immediately
    this.pollBalances().catch((err: Error) => this.emit("error", err));
  }

  /** Stop monitoring. */
  stopMonitoring(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollBalances(): Promise<void> {
    await this.ensureConnected();
    for (const [address, sh] of this.watchedAddresses) {
      try {
        const bal = await this.electrumx.getBalance(sh);
        const prev = this.lastKnownBalance.get(sh);
        const current = bal.confirmed + bal.unconfirmed;

        if (prev !== undefined && current !== prev) {
          const event: AgentEvent = {
            type: current > prev ? "payment-received" : "balance-changed",
            address,
            timestamp: Date.now(),
            data: {
              previous: { photons: prev, rxd: satoshisToRxd(prev) },
              current: { photons: current, rxd: satoshisToRxd(current) },
              change: { photons: current - prev, rxd: satoshisToRxd(current - prev) },
            },
          };
          this.emit(event.type, event);
          this.emit("balance-changed", event);
        }

        this.lastKnownBalance.set(sh, current);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  Utility
  // ══════════════════════════════════════════════════════════

  /** Validate a Radiant address. */
  validateAddress(address: string): boolean {
    return isValidAddress(address);
  }

  /** Get network parameters. */
  getNetworkParams() {
    return NETWORK_PARAMS[this.config.network];
  }

  /** Get Glyph protocol definitions. */
  getProtocols() {
    return GLYPH_PROTOCOLS;
  }

  /** Get dMint algorithm definitions. */
  getAlgorithms() {
    return DMINT_ALGORITHMS;
  }
}

export { AgentWallet } from "./wallet.js";
export {
  createInferenceProof,
  verifyInferenceProof,
  buildAgentProfile,
  buildAgentWaveRecords,
  parseAgentCapabilities,
  checkTokenGatedAccess,
  openChannel,
  updateChannel,
  computeChannelCommitment,
  channelSummary,
  buildDataAssetMetadata,
  computeProvenanceCommitment,
  searchDataAssets,
} from "./primitives.js";
export type {
  InferenceProofData,
  AgentProfile,
  AccessCheckResult,
  ChannelState,
  DataAsset,
} from "./primitives.js";
