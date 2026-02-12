import * as net from "node:net";
import * as tls from "node:tls";
import { EventEmitter } from "node:events";

export interface ElectrumxConfig {
  host: string;
  port: number;
  ssl: boolean;
  timeout?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal ElectrumX JSON-RPC client over TCP/TLS.
 * Supports standard ElectrumX protocol + Glyph/WAVE/dMint extensions.
 */
export class ElectrumxClient extends EventEmitter {
  private config: ElectrumxConfig;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private connected = false;
  private reconnecting = false;

  constructor(config: ElectrumxConfig) {
    super();
    this.config = {
      timeout: 30_000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connected = true;
        this.reconnecting = false;
        this.emit("connected");
        resolve();
      };

      const onError = (err: Error) => {
        this.connected = false;
        reject(err);
      };

      if (this.config.ssl) {
        this.socket = tls.connect(
          {
            host: this.config.host,
            port: this.config.port,
            rejectUnauthorized: false,
          },
          onConnect,
        );
      } else {
        this.socket = net.createConnection(
          { host: this.config.host, port: this.config.port },
          onConnect,
        );
      }

      this.socket.setEncoding("utf8");
      this.socket.once("error", onError);
      this.socket.on("data", (data: string) => this.onData(data));
      this.socket.on("close", () => this.onClose());
      this.socket.on("error", (err: Error) => this.emit("error", err));
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.reconnecting = false;
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Client disconnected"));
      this.pending.delete(id);
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a JSON-RPC request to the ElectrumX server.
   */
  async request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.connected || !this.socket) {
      await this.connect();
    }

    const id = ++this.requestId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method} (${this.config.timeout}ms)`));
      }, this.config.timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.socket!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Subscription notification (no id)
        if (msg.method && !msg.id) {
          this.emit("notification", msg);
          continue;
        }

        const req = this.pending.get(msg.id);
        if (!req) continue;

        clearTimeout(req.timer);
        this.pending.delete(msg.id);

        if (msg.error) {
          req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          req.resolve(msg.result);
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  }

  private onClose(): void {
    this.connected = false;
    this.emit("disconnected");
  }

  // ──────────────────────────────────────────────
  // Convenience methods for common ElectrumX calls
  // ──────────────────────────────────────────────

  async serverVersion(
    clientName = "radiant-mcp-server",
    protocolVersion = "1.4",
  ): Promise<[string, string]> {
    return this.request("server.version", [clientName, protocolVersion]);
  }

  async getBalance(scripthash: string): Promise<{ confirmed: number; unconfirmed: number }> {
    return this.request("blockchain.scripthash.get_balance", [scripthash]);
  }

  async listUnspent(scripthash: string): Promise<Array<{
    tx_hash: string;
    tx_pos: number;
    height: number;
    value: number;
  }>> {
    return this.request("blockchain.scripthash.listunspent", [scripthash]);
  }

  async getHistory(scripthash: string): Promise<Array<{
    tx_hash: string;
    height: number;
    fee?: number;
  }>> {
    return this.request("blockchain.scripthash.get_history", [scripthash]);
  }

  async getTransaction(txid: string, verbose = true): Promise<unknown> {
    return this.request("blockchain.transaction.get", [txid, verbose]);
  }

  async broadcastTransaction(rawTx: string): Promise<string> {
    return this.request("blockchain.transaction.broadcast", [rawTx]);
  }

  async estimateFee(blocks: number): Promise<number> {
    return this.request("blockchain.estimatefee", [blocks]);
  }

  async getBlockHeader(height: number): Promise<unknown> {
    return this.request("blockchain.block.header", [height]);
  }

  async headersSubscribe(): Promise<{ height: number; hex: string }> {
    return this.request("blockchain.headers.subscribe", []);
  }

  // ──────────────────────────────────────────────
  // Glyph API methods (RXinDexer extensions)
  // ──────────────────────────────────────────────

  async glyphGetToken(glyphId: string): Promise<unknown> {
    return this.request("glyph.get_token", [glyphId]);
  }

  async glyphGetByRef(ref: string): Promise<unknown> {
    return this.request("glyph.get_by_ref", [ref]);
  }

  async glyphValidateProtocols(protocols: number[]): Promise<unknown> {
    return this.request("glyph.validate_protocols", [protocols]);
  }

  async glyphGetProtocolInfo(): Promise<unknown> {
    return this.request("glyph.get_protocol_info", []);
  }

  async glyphParseEnvelope(scriptHex: string): Promise<unknown> {
    return this.request("glyph.parse_envelope", [scriptHex]);
  }

  async glyphGetTokenInfo(ref: string): Promise<unknown> {
    return this.request("glyph.get_token_info", [ref]);
  }

  async glyphGetBalance(scripthash: string, ref: string): Promise<unknown> {
    return this.request("glyph.get_balance", [scripthash, ref]);
  }

  async glyphListTokens(scripthash: string, limit = 100): Promise<unknown> {
    return this.request("glyph.list_tokens", [scripthash, limit]);
  }

  async glyphGetHistory(ref: string, limit = 100, offset = 0): Promise<unknown> {
    return this.request("glyph.get_history", [ref, limit, offset]);
  }

  async glyphSearchTokens(query: string, protocols?: number[], limit = 50): Promise<unknown> {
    const params: unknown[] = [query];
    if (protocols) params.push(protocols);
    params.push(limit);
    return this.request("glyph.search_tokens", params);
  }

  async glyphGetTokensByType(tokenType: number, limit = 100, offset = 0): Promise<unknown> {
    return this.request("glyph.get_tokens_by_type", [tokenType, limit, offset]);
  }

  async glyphGetMetadata(ref: string): Promise<unknown> {
    return this.request("glyph.get_metadata", [ref]);
  }

  // ──────────────────────────────────────────────
  // dMint API methods
  // ──────────────────────────────────────────────

  async dmintGetContracts(format = "simple"): Promise<unknown> {
    return this.request("dmint.get_contracts", [format]);
  }

  async dmintGetContract(ref: string): Promise<unknown> {
    return this.request("dmint.get_contract", [ref]);
  }

  async dmintGetByAlgorithm(algorithm: number): Promise<unknown> {
    return this.request("dmint.get_by_algorithm", [algorithm]);
  }

  async dmintGetMostProfitable(limit = 10): Promise<unknown> {
    return this.request("dmint.get_most_profitable", [limit]);
  }

  // ──────────────────────────────────────────────
  // WAVE API methods
  // ──────────────────────────────────────────────

  async waveResolve(name: string): Promise<unknown> {
    return this.request("wave.resolve", [name]);
  }

  async waveCheckAvailable(name: string): Promise<unknown> {
    return this.request("wave.check_available", [name]);
  }

  async waveGetSubdomains(parentName: string, limit = 100, offset = 0): Promise<unknown> {
    return this.request("wave.get_subdomains", [parentName, limit, offset]);
  }

  async waveReverseLookup(scripthash: string, limit = 100): Promise<unknown> {
    return this.request("wave.reverse_lookup", [scripthash, limit]);
  }

  async waveStats(): Promise<unknown> {
    return this.request("wave.stats", []);
  }

  // ──────────────────────────────────────────────
  // Swap API methods
  // ──────────────────────────────────────────────

  async swapGetOrders(
    sellRef: string,
    buyRef: string,
    limit = 100,
    offset = 0,
  ): Promise<unknown> {
    return this.request("swap.get_orders", [sellRef, buyRef, limit, offset]);
  }

  async swapGetHistory(ref: string, limit = 100, offset = 0): Promise<unknown> {
    return this.request("swap.get_history", [ref, limit, offset]);
  }
}
