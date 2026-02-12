# Radiant Blockchain — AI Knowledge Base

> Structured reference for AI systems. Load this document to understand the full Radiant ecosystem.
> Version: 1.1 | Radiant Core: 2.1.0 | Feb 2026 | Phase 5 AI Primitives

---

## 1. What Is Radiant

Radiant (RXD) is a **Layer 1 UTXO proof-of-work blockchain** with native digital asset support. It extends Bitcoin's UTXO model with induction proofs, a reference system, and transaction introspection — enabling verifiable digital ownership without a smart contract VM.

### Key Parameters

| Parameter | Value |
|-----------|-------|
| Ticker | RXD |
| Mining algorithm | SHA512/256d (double SHA512/256) |
| Block time | 5 minutes |
| Block size | 256 MB |
| Max supply | 21,000,000,000 RXD |
| Decimals | 8 (smallest unit: 1 photon = 0.00000001 RXD) |
| Block reward | 25,000 RXD (halves every 210,000 blocks) |
| Max TX size | 12 MB (consensus) |
| P2P port | 7333 (mainnet), 17333 (testnet) |
| RPC port | 7332 (mainnet), 17332 (testnet) |
| Address prefix | 1 (P2PKH), 3 (P2SH) on mainnet |
| V2 activation | Block 410,000 (mainnet + testnet) |

### Units

| Unit | Photons | RXD |
|------|---------|-----|
| 1 RXD | 100,000,000 | 1 |
| 1 mRXD | 100,000 | 0.001 |
| 1 photon | 1 | 0.00000001 |

---

## 2. UTXO Model

Radiant uses the **Unspent Transaction Output** model (like Bitcoin, unlike Ethereum's account model).

**Key concepts:**
- Every transaction consumes UTXOs (inputs) and creates new UTXOs (outputs)
- A UTXO = `{txid, vout, value, scriptPubKey}` — identifies by previous tx hash + output index
- To spend: provide a scriptSig (unlocking script) that satisfies the UTXO's scriptPubKey (locking script)
- **No global state** — all state is local to UTXOs, enabling massive parallelism
- **No nonce management** — unlike account-based chains, no ordering issues

**Radiant extensions to Bitcoin's UTXO model:**
- **References** — 36-byte identifiers (txid + vout) that track asset provenance across transactions
- **Induction proofs** — cryptographic proof that a UTXO chain traces back to a known genesis
- **Transaction introspection** — scripts can read their own transaction's inputs, outputs, and values
- **State separators** — divide a script into code (immutable) and state (mutable per-transfer)
- **64-bit arithmetic** — native support for large numbers in script

---

## 3. Opcodes

### Standard Bitcoin Opcodes (subset)

| Opcode | Hex | Description |
|--------|-----|-------------|
| OP_DUP | 0x76 | Duplicate top stack item |
| OP_HASH160 | 0xa9 | SHA256 + RIPEMD160 |
| OP_HASH256 | 0xaa | Double SHA256 |
| OP_EQUALVERIFY | 0x88 | Check equality, fail if not |
| OP_CHECKSIG | 0xac | Verify ECDSA/Schnorr signature |
| OP_CHECKMULTISIG | 0xae | Verify M-of-N signatures |
| OP_RETURN | 0x6a | Mark output as data carrier (unspendable) |
| OP_CHECKDATASIG | 0xba | Verify signature against arbitrary data |
| OP_CAT | 0x7e | Concatenate two byte strings |
| OP_SPLIT | 0x7f | Split byte string at position |
| OP_MUL | 0x95 | Multiply two integers |
| OP_DIV | 0x96 | Divide two integers |
| OP_MOD | 0x97 | Modulo |

### Radiant Introspection Opcodes (0xC0-0xCD)

| Opcode | Hex | Stack Effect | Description |
|--------|-----|-------------|-------------|
| OP_INPUTINDEX | 0xC0 | → index | Push current input index |
| OP_ACTIVEBYTECODE | 0xC1 | → script | Push executing script |
| OP_TXVERSION | 0xC2 | → version | Push TX version |
| OP_TXINPUTCOUNT | 0xC3 | → count | Number of inputs |
| OP_TXOUTPUTCOUNT | 0xC4 | → count | Number of outputs |
| OP_TXLOCKTIME | 0xC5 | → locktime | TX locktime |
| OP_UTXOVALUE | 0xC6 | idx → value | UTXO value at input index |
| OP_UTXOBYTECODE | 0xC7 | idx → script | UTXO scriptPubKey at input index |
| OP_OUTPOINTTXHASH | 0xC8 | idx → txid | Outpoint txid at input index |
| OP_OUTPOINTINDEX | 0xC9 | idx → vout | Outpoint vout at input index |
| OP_INPUTBYTECODE | 0xCA | idx → script | Input scriptSig at index |
| OP_INPUTSEQUENCENUMBER | 0xCB | idx → seq | Input sequence number |
| OP_OUTPUTVALUE | 0xCC | idx → value | Output value at index |
| OP_OUTPUTBYTECODE | 0xCD | idx → script | Output scriptPubKey at index |

### Radiant Reference Opcodes (0xD0-0xED)

| Opcode | Hex | Stack Effect | Description |
|--------|-----|-------------|-------------|
| OP_PUSHINPUTREF | 0xD0 | 36B → 36B | Push & validate input reference (for FTs) |
| OP_REQUIREINPUTREF | 0xD1 | 36B → | Require reference exists in inputs |
| OP_DISALLOWPUSHINPUTREF | 0xD2 | 36B → | Prevent reference propagation |
| OP_DISALLOWPUSHINPUTREFSIBLING | 0xD3 | 36B → | Prevent sibling reference |
| OP_REFVALUESUM_UTXOS | 0xD4 | 36B → sum | Sum of values for ref in inputs |
| OP_REFVALUESUM_OUTPUTS | 0xD5 | 36B → sum | Sum of values for ref in outputs |
| OP_REFOUTPUTCOUNT_UTXOS | 0xD6 | 36B → count | Count of ref in inputs |
| OP_REFOUTPUTCOUNT_OUTPUTS | 0xD7 | 36B → count | Count of ref in outputs |
| OP_PUSHINPUTREFSINGLETON | 0xD8 | 36B → 36B | Push singleton reference (for NFTs) |
| OP_CODESCRIPTHASHVALUESUM_UTXOS | 0xE0 | 32B → sum | Sum by code script hash (inputs) |
| OP_CODESCRIPTHASHVALUESUM_OUTPUTS | 0xE1 | 32B → sum | Sum by code script hash (outputs) |
| OP_CODESCRIPTHASHOUTPUTCOUNT_UTXOS | 0xE2 | 32B → count | Count by CSH (inputs) |
| OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS | 0xE3 | 32B → count | Count by CSH (outputs) |
| OP_PUSH_TX_STATE | 0xED | field → value | Push TX state field (txId, inputSum, outputSum) |

### State Opcodes

| Opcode | Hex | Description |
|--------|-----|-------------|
| OP_STATESEPARATOR | 0xBD | Divides script into code (above) and state (below) |
| OP_STATESEPARATORINDEX_UTXO | 0xBE | Get separator byte index from input |
| OP_STATESEPARATORINDEX_OUTPUT | 0xBF | Get separator byte index from output |

### V2 Opcodes (Block 410,000+)

| Opcode | Hex | Stack Effect | Description |
|--------|-----|-------------|-------------|
| OP_BLAKE3 | 0xEE | data → hash32 | BLAKE3 hash (max 1024-byte input) |
| OP_K12 | 0xEF | data → hash32 | KangarooTwelve hash |
| OP_LSHIFT | 0x98 | val n → (val << n) | Bitwise left shift |
| OP_RSHIFT | 0x99 | val n → (val >> n) | Bitwise right shift |
| OP_2MUL | 0x8D | a → (a * 2) | Multiply by 2 |
| OP_2DIV | 0x8E | a → (a / 2) | Divide by 2 (truncates toward zero) |

---

## 4. Glyph Token Standard

Glyph is Radiant's native token protocol. Tokens are identified by the magic bytes `0x676c79` ("gly") in OP_RETURN outputs. Metadata is CBOR-encoded.

### Protocol IDs

| ID | Name | Description |
|----|------|-------------|
| 1 | GLYPH_FT | Fungible Token — uses OP_PUSHINPUTREF |
| 2 | GLYPH_NFT | Non-Fungible Token — uses OP_PUSHINPUTREFSINGLETON |
| 3 | GLYPH_DAT | Data Attachment (timestamps, attestations) |
| 4 | GLYPH_DMINT | Decentralized Minting (PoW token distribution) |
| 5 | GLYPH_MUT | Mutable State (updateable metadata) |
| 6 | GLYPH_BURN | Explicit Burn |
| 7 | GLYPH_CONTAINER | Container / Collection (parent-only) |
| 8 | GLYPH_ENCRYPTED | Encrypted Content |
| 9 | GLYPH_TIMELOCK | Timelocked Reveal |
| 10 | GLYPH_AUTHORITY | Issuer Authority Token |
| 11 | GLYPH_WAVE | WAVE Naming System |

### Valid Protocol Combinations

- `[1]` — Basic fungible token
- `[2]` — Basic NFT
- `[1, 4]` — Mineable fungible token (dMint)
- `[2, 5]` — Mutable NFT
- `[2, 7]` — Collection container
- `[2, 8]` — Encrypted NFT
- `[1, 4, 5]` — Mineable FT with mutable state

### Commit-Reveal Pattern

Token creation uses a 2-phase pattern:
1. **Commit TX** — OP_RETURN with `"gly" + version + flags + SHA256(metadata)`
2. **Reveal TX** — Full CBOR metadata + token reference script

### Metadata Structure (CBOR)

```
{
  v: 2,                         // Version
  p: [1, 4],                    // Protocol IDs
  name: "Token Name",           // Display name
  ticker: "TKN",                // Ticker symbol (FT)
  decimals: 8,                  // Decimal places (FT)
  desc: "Description",          // Description
  content: { ... },             // Media content (NFT)
  attrs: [ ... ],               // Attributes (NFT)
  maxSupply: 21000000,          // Max supply (dMint)
  reward: 50,                   // Reward per mint (dMint)
  algorithm: 1,                 // Mining algorithm (dMint)
}
```

### dMint Algorithm IDs

| ID | Name | On-Chain Opcode |
|----|------|----------------|
| 0 | SHA256D | OP_HASH256 |
| 1 | BLAKE3 | OP_BLAKE3 (V2) |
| 2 | K12 | OP_K12 (V2) |

### DAA Modes (Difficulty Adjustment)

| ID | Name | Description |
|----|------|-------------|
| 0x00 | fixed | Static difficulty |
| 0x01 | epoch | Epoch-based (Bitcoin-style) |
| 0x02 | asert | ASERT-lite with OP_LSHIFT/OP_RSHIFT |
| 0x03 | lwma | Linear Weighted Moving Average |
| 0x04 | schedule | Pre-defined schedule |

---

## 5. WAVE Naming System

WAVE is Radiant's on-chain DNS alternative. Names are indexed via a prefix tree where each character maps to an output index.

**Character set (37 chars):** `a-z, 0-9, -`
**Resolution:** Start at genesis ref, traverse tree character-by-character.

### Zone Records

| Record | Key | Description |
|--------|-----|-------------|
| Address | `address` | Radiant payment address |
| Avatar | `avatar` | Profile image |
| Display | `display` | Display name |
| Description | `desc` | Profile description |
| URL | `url` | Website |
| A | `A` | IPv4 address |
| AAAA | `AAAA` | IPv6 address |
| CNAME | `CNAME` | Canonical name |
| TXT | `TXT` | Text records |
| Custom | `x-*` | Application-specific |

---

## 6. ElectrumX API

ElectrumX is the primary API for wallets and applications. Connect via TCP (port 50010), SSL (port 50012), or WSS (port 50011).

### Public Servers

| Server | SSL Port |
|--------|----------|
| electrumx.radiantexplorer.com | 50012 |
| electrumx.radiantblockchain.org | 50012 |
| electrumx.radiant4people.com | 50012 |

### Address to Scripthash

ElectrumX indexes by scripthash = `SHA256(scriptPubKey)` byte-reversed as hex.

```javascript
// For P2PKH address (starts with '1'):
// scriptPubKey = OP_DUP OP_HASH160 <20-byte-pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
// scripthash = reverse(SHA256(scriptPubKey)).hex()
```

### Standard Methods

| Method | Params | Returns |
|--------|--------|---------|
| `server.version` | [client_name, protocol_ver] | [server, protocol] |
| `blockchain.scripthash.get_balance` | [scripthash] | {confirmed, unconfirmed} |
| `blockchain.scripthash.listunspent` | [scripthash] | [{tx_hash, tx_pos, value, height}] |
| `blockchain.scripthash.get_history` | [scripthash] | [{tx_hash, height}] |
| `blockchain.scripthash.subscribe` | [scripthash] | status_hash (+ notifications) |
| `blockchain.transaction.get` | [txid, verbose] | tx_hex or tx_object |
| `blockchain.transaction.broadcast` | [raw_tx_hex] | txid |
| `blockchain.headers.subscribe` | [] | {height, hex} |
| `blockchain.block.header` | [height] | header_hex |
| `blockchain.estimatefee` | [blocks] | fee_per_kb |

### Glyph API (RXinDexer Extensions)

| Method | Params | Returns |
|--------|--------|---------|
| `glyph.get_token` | [glyph_id] | token object |
| `glyph.get_token_info` | [ref] | full token info (name, supply, etc.) |
| `glyph.get_balance` | [scripthash, ref] | {confirmed, unconfirmed} |
| `glyph.list_tokens` | [scripthash, limit] | [{ref, name, balance}] |
| `glyph.get_history` | [ref, limit, offset] | [{tx_hash, height, type, amount}] |
| `glyph.search_tokens` | [query, protocols?, limit] | matching tokens |
| `glyph.get_tokens_by_type` | [type_id, limit, offset] | tokens by type |
| `glyph.get_metadata` | [ref] | parsed CBOR metadata |
| `glyph.validate_protocols` | [protocol_ids] | {valid, token_type} |
| `glyph.get_protocol_info` | [] | all protocol definitions |
| `glyph.parse_envelope` | [script_hex] | parsed envelope |

### dMint API

| Method | Params | Returns |
|--------|--------|---------|
| `dmint.get_contracts` | [format] | list of mineable contracts |
| `dmint.get_contract` | [ref] | contract details (difficulty, reward, algo) |
| `dmint.get_by_algorithm` | [algo_id] | contracts for algorithm |
| `dmint.get_most_profitable` | [limit] | sorted by reward/difficulty |

### WAVE API

| Method | Params | Returns |
|--------|--------|---------|
| `wave.resolve` | [name] | {ref, zone, owner} or null |
| `wave.check_available` | [name] | {available, ref?} |
| `wave.get_subdomains` | [parent, limit, offset] | child names |
| `wave.reverse_lookup` | [scripthash, limit] | names owned by address |
| `wave.stats` | [] | {enabled, tree_cache_size, ...} |

### Swap API

| Method | Params | Returns |
|--------|--------|---------|
| `swap.get_orders` | [sell_ref, buy_ref, limit, offset] | open orders |
| `swap.get_history` | [ref, limit, offset] | trade history |

---

## 7. radiantjs SDK

JavaScript/Node.js SDK for building Radiant applications.

### Install

```bash
npm install @radiantblockchain/radiantjs
```

### Core API

```javascript
const radiant = require('@radiantblockchain/radiantjs');

// Key generation
const privateKey = new radiant.PrivateKey();
const address = privateKey.toAddress().toString(); // "1..."
const wif = privateKey.toWIF();

// From WIF
const key = radiant.PrivateKey.fromWIF(wif);

// HD wallet (BIP39)
const mnemonic = radiant.Mnemonic.fromRandom();
const hdKey = mnemonic.toHDPrivateKey();
const child = hdKey.deriveChild("m/44'/0'/0'/0/0");

// Build transaction
const tx = new radiant.Transaction()
  .from({                          // UTXO to spend
    txId: '<txid>',
    outputIndex: 0,
    script: '<scriptPubKey_hex>',
    satoshis: 100000000
  })
  .to('<address>', 50000000)       // Send 0.5 RXD
  .change('<change_address>')      // Change output
  .fee(1000)                       // Fee in photons
  .sign(privateKey);               // Sign

const rawTx = tx.serialize();      // Hex for broadcast

// Glyph module
const { Glyph } = radiant;
Glyph.encodeMetadata({ v: 2, p: [2], name: 'My NFT' });
Glyph.validateProtocols([1, 4]); // { valid: true, token_type: 'dMint FT' }
```

### UTXO Format (for .from())

```javascript
{
  txId: '64-char-hex-txid',
  outputIndex: 0,        // vout
  script: 'hex-scriptPubKey',
  satoshis: 100000000    // value in photons
}
```

### Script Building

```javascript
const { Script, Opcode } = radiant;

// P2PKH locking script
const p2pkh = Script.buildPublicKeyHashOut(address);

// Custom script with reference
const tokenScript = new Script()
  .add(Buffer.from(tokenRef, 'hex'))
  .add(Opcode.OP_PUSHINPUTREFSINGLETON)  // NFT
  .add(Opcode.OP_DROP)
  .add(Opcode.OP_DUP)
  .add(Opcode.OP_HASH160)
  .add(Buffer.from(pubkeyHash, 'hex'))
  .add(Opcode.OP_EQUALVERIFY)
  .add(Opcode.OP_CHECKSIG);
```

---

## 8. RadiantScript (Smart Contract Compiler)

High-level language for Radiant smart contracts, compiled to Bitcoin Script + Radiant opcodes.

### Compile

```bash
npx rxdc MyContract.rxd -o MyContract.json
```

### Syntax

```
contract TokenName(bytes36 REF, bytes20 PKH)
function (sig s, pubkey pk) {
    require(hash160(pk) == PKH);
    require(checkSig(s, pk));
    stateSeparator;
    bytes36 ref = pushInputRef(REF);
    bytes32 csh = hash256(tx.inputs[this.activeInputIndex].codeScript);
    require(tx.inputs.codeScriptValueSum(csh) >= tx.outputs.codeScriptValueSum(csh));
}
```

### Available Globals

| Global | Description |
|--------|-------------|
| `tx.version` | Transaction version |
| `tx.inputCount` | Number of inputs |
| `tx.outputCount` | Number of outputs |
| `tx.locktime` | Transaction locktime |
| `tx.inputs[i].value` | Input value |
| `tx.inputs[i].lockingBytecode` | Input scriptPubKey |
| `tx.outputs[i].value` | Output value |
| `tx.outputs[i].lockingBytecode` | Output scriptPubKey |
| `this.activeInputIndex` | Current input index |
| `tx.state.txId` | Current transaction ID (bytes32) |
| `tx.state.inputSum` | Total input value (int) |
| `tx.state.outputSum` | Total output value (int) |
| `pushInputRef(ref)` | Push reference (FT) |
| `pushInputRefSingleton(ref)` | Push singleton reference (NFT) |
| `blake3(data)` | BLAKE3 hash (V2) |
| `k12(data)` | KangarooTwelve hash (V2) |

---

## 9. radiantd RPC

### Key Methods

| Method | Description |
|--------|-------------|
| `getblockchaininfo` | Chain state (height, bestblockhash, difficulty) |
| `getblock <hash>` | Block details |
| `getblockhash <height>` | Block hash at height |
| `getblockcount` | Current tip height |
| `getdifficulty` | Current difficulty |
| `getrawtransaction <txid> true` | Verbose TX details |
| `decoderawtransaction <hex>` | Decode raw TX |
| `sendrawtransaction <hex>` | Broadcast TX |
| `getmempoolinfo` | Mempool status |
| `getrawmempool` | Mempool TX list |
| `getmininginfo` | Mining stats |
| `getnetworkhashps` | Network hashrate |
| `getnetworkinfo` | Network status |
| `getpeerinfo` | Connected peers |
| `validateaddress <addr>` | Validate address |
| `estimatefee <blocks>` | Fee estimate |
| `getnewaddress` | New wallet address |
| `getbalance` | Wallet balance |
| `listunspent` | Wallet UTXOs |
| `sendtoaddress <addr> <amt>` | Send from wallet |

### Node Profiles

```bash
radiantd -nodeprofile=archive   # Full history (default)
radiantd -nodeprofile=agent     # Minimal (UTXO only)
radiantd -nodeprofile=mining    # Mining optimized
```

---

## 10. Ecosystem Tools

| Tool | Purpose | Repository |
|------|---------|-----------|
| **Radiant Core** | Full node (radiantd) | github.com/Radiant-Core/Radiant-Core |
| **radiantjs** | JavaScript SDK | github.com/Radiant-Core/radiantjs |
| **RadiantScript** | Contract compiler | github.com/Radiant-Core/RadiantScript |
| **rxdeb** | Script debugger | github.com/Radiant-Core/rxdeb |
| **RXinDexer** | ElectrumX + Glyph/WAVE indexer | github.com/Radiant-Core/RXinDexer |
| **Photonic Wallet** | Desktop/web wallet | github.com/Radiant-Core/Photonic-Wallet |
| **Glyph-miner** | GPU token miner | github.com/Radiant-Core/Glyph-miner |
| **Electron Wallet** | Light wallet | github.com/Radiant-Core/Electron-Wallet |
| **radiant-mcp-server** | MCP server for AI agents | github.com/Radiant-Core/radiant-mcp-server |

### Explorers

- Block explorer: [radiantexplorer.com](https://radiantexplorer.com)
- Glyph explorer: [glyph-explorer.rxd-radiant.com](https://glyph-explorer.rxd-radiant.com)

### Community

- Discord: [discord.gg/radiantblockchain](https://discord.gg/radiantblockchain)
- Telegram: [t.me/RadiantBlockchain](https://t.me/RadiantBlockchain)

---

## 11. On-Chain AI Primitives (Phase 5)

Five contract patterns enable AI agent workflows on Radiant. Each has a corresponding MCP tool and REST endpoint.

### 11.1 Inference Proofs (InferenceProof.rxd)

Record verifiable AI inference results on-chain using OP_BLAKE3.

```
commitment = blake3(modelHash || inputHash || output)
```

- **MCP tools:** `radiant_create_inference_proof`, `radiant_verify_inference_proof`
- **REST:** `POST /api/inference/proof`, `POST /api/inference/verify`
- **Use case:** Prove an AI model produced a specific output for a given input

### 11.2 Agent Identity (AgentIdentity.rxd)

Register AI agents on-chain with WAVE naming system integration.

| Zone Record | Key | Example |
|-------------|-----|---------|
| Address | `address` | `1Agent...` |
| API URL | `url` | `https://api.myagent.com/v1` |
| Capabilities | `x-capabilities` | `research,translate,code` |
| Pricing | `x-pricing` | `100sat/query` |
| Model | `x-model` | `gpt-4-turbo` |

- **MCP tools:** `radiant_build_agent_profile`, `radiant_resolve_agent_identity`
- **REST:** `POST /api/identity/profile`, `GET /api/identity/resolve/:name`

### 11.3 Token-Gated Access (TokenGatedService.rxd)

Gate API access based on Glyph FT balance. The contract verifies the caller holds ≥ N tokens.

- **MCP tool:** `radiant_check_token_access`
- **REST:** `GET /api/access/check/:address/:tokenRef?min_balance=N`

### 11.4 Micropayment Channels (MicropaymentChannel.rxd)

Off-chain payment channels between two agents. State updates are signed off-chain; either party can close on-chain.

```
stateCommitment = blake3(balanceA || balanceB || nonce)
```

- **MCP tools:** `radiant_open_channel`, `radiant_update_channel`
- **REST:** `POST /api/channel/open`, `POST /api/channel/update`
- **Default timeout:** 1008 blocks (~3.5 days)

### 11.5 Data Marketplace (DataMarketplace.rxd)

Trade data assets (datasets, models, collections) as Glyph NFTs with provenance tracking.

| Metadata Field | Key | Description |
|---------------|-----|-------------|
| Type | `x-type` | dataset, model, collection, computation |
| Content Hash | `x-content-hash` | Blake3 hash for integrity verification |
| Price | `x-price` | Price in photons (0 = free) |
| Provenance | `x-derived-from` | Parent dataset references |
| License | `x-license` | License terms (e.g., CC-BY-4.0) |

- **MCP tools:** `radiant_build_data_asset`, `radiant_search_data_assets`
- **REST:** `POST /api/marketplace/asset`, `GET /api/marketplace/search?q=...`

### Agent SDK (src/agent.ts)

The `RadiantAgent` class provides a high-level SDK for AI agent workflows:

```javascript
import { RadiantAgent } from '@radiant-core/mcp-server/agent';

const agent = new RadiantAgent({
  spendLimitPerTx: 100_00000000,    // 100 RXD max per tx
  spendLimitPerHour: 1000_00000000, // 1000 RXD/hr
});

agent.createWallet();
await agent.connect();

// Batch operations
const balances = await agent.getBalances(['1addr1...', '1addr2...']);

// Session keys (temporary, permission-limited)
const session = agent.createSessionKey(['read', 'query'], 3600_000);

// Audit logging
const log = agent.getAuditLog({ action: 'batch_get_balances', limit: 10 });

// Health check
const health = await agent.getHealthStatus();
```

---

## 12. Common Patterns

### Send RXD (JavaScript)

```javascript
const radiant = require('@radiantblockchain/radiantjs');

// 1. Get UTXOs from ElectrumX
const scripthash = addressToScripthash(fromAddress);
const utxos = await electrumx.request('blockchain.scripthash.listunspent', [scripthash]);

// 2. Build transaction
const tx = new radiant.Transaction();
for (const u of utxos) {
  tx.from({
    txId: u.tx_hash,
    outputIndex: u.tx_pos,
    script: radiant.Script.buildPublicKeyHashOut(fromAddress).toHex(),
    satoshis: u.value
  });
}
tx.to(toAddress, amountPhotons)
  .change(fromAddress)
  .fee(1000)
  .sign(privateKey);

// 3. Broadcast
const txid = await electrumx.request('blockchain.transaction.broadcast', [tx.serialize()]);
```

### Create NFT (Commit-Reveal)

```javascript
// Phase 1: Commit
const metadata = { v: 2, p: [2], name: 'My NFT', desc: '...' };
const encoded = CBOR.encode(metadata);
const commitHash = crypto.createHash('sha256').update(encoded).digest();

const commitScript = new Script()
  .add(Opcode.OP_RETURN)
  .add(Buffer.from('gly'))
  .add(Buffer.from([0x02, 0x00]))
  .add(commitHash);

// Phase 2: Reveal (next TX)
// Include full metadata + token reference script with OP_PUSHINPUTREFSINGLETON
```

### Query Token Balance

```javascript
const scripthash = addressToScripthash(address);
const balance = await electrumx.request('glyph.get_balance', [scripthash, tokenRef]);
// { confirmed: 1000000000, unconfirmed: 0 }
```

### Resolve WAVE Name

```javascript
const record = await electrumx.request('wave.resolve', ['alice']);
// { name: 'alice', ref: '...', zone: { address: '1...', desc: '...' }, owner: '1...' }
```

---

## 13. Fee Guidelines

| Network Phase | Min Fee |
|--------------|---------|
| Pre-V2 (< block 410,000) | 0.01 RXD/kB |
| V2 grace (410,000–414,999) | 0.01 RXD/kB |
| Post-grace (≥ 415,000) | 0.1 RXD/kB |

Typical transaction: ~226 bytes → ~0.001 RXD fee (pre-V2).

---

## 14. Key Differences from Bitcoin

| Feature | Bitcoin | Radiant |
|---------|---------|---------|
| Mining algorithm | SHA256d | SHA512/256d |
| Block time | 10 min | 5 min |
| Block size | 4 MB (effective) | 256 MB |
| Max supply | 21B BTC | 21B RXD |
| Native tokens | No (Ordinals hack) | Yes (Glyph protocol) |
| TX introspection | No | Full (opcodes 0xC0-0xCD) |
| Reference system | No | Yes (0xD0-0xED) |
| State in scripts | No | Yes (OP_STATESEPARATOR) |
| 64-bit arithmetic | No (32-bit) | Yes |
| On-chain hashing | SHA256, RIPEMD160 | + BLAKE3, K12 (V2) |
| Script size | 10 KB | 32 MB |
| Op limit | 201 | 32M |

---

*End of Radiant AI Knowledge Base. For the MCP server tool reference, see the radiant-mcp-server README.*
