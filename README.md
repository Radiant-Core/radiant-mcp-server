# Radiant MCP Server

**Model Context Protocol (MCP) server for the Radiant blockchain** — enables AI agents to query chain state, manage Glyph tokens, resolve WAVE names, and interact with the Radiant ecosystem.

## Features

### 29 Tools across 6 categories:

**Blockchain (8 tools)**
- `radiant_get_chain_info` — Current chain status (height, tip, params)
- `radiant_get_balance` — RXD balance for address
- `radiant_get_utxos` — List unspent outputs
- `radiant_get_history` — Transaction history for address
- `radiant_get_transaction` — Transaction details by txid
- `radiant_get_block_header` — Block header by height
- `radiant_estimate_fee` — Fee estimation
- `radiant_broadcast_transaction` — Broadcast signed raw tx

**Glyph Tokens (9 tools)**
- `radiant_get_token` — Token info by reference
- `radiant_list_tokens` — Tokens held by address
- `radiant_get_token_balance` — Specific token balance
- `radiant_search_tokens` — Search by name/ticker
- `radiant_get_token_metadata` — Full CBOR metadata
- `radiant_get_token_history` — Token transaction history
- `radiant_get_tokens_by_type` — Filter by type (FT/NFT/etc.)
- `radiant_validate_protocols` — Check protocol combinations
- `radiant_parse_glyph_envelope` — Decode script to token data

**dMint Mining (4 tools)**
- `radiant_get_dmint_contracts` — List mineable tokens
- `radiant_get_dmint_contract` — Contract details
- `radiant_get_dmint_by_algorithm` — Filter by algorithm
- `radiant_get_most_profitable_dmint` — Ranked by profitability

**WAVE Naming (5 tools)**
- `radiant_resolve_wave_name` — Resolve name to records
- `radiant_check_wave_available` — Check name availability
- `radiant_wave_reverse_lookup` — Address to names
- `radiant_wave_subdomains` — List child names
- `radiant_wave_stats` — Naming system statistics

**DEX (1 tool)**
- `radiant_get_swap_orders` — On-chain orderbook

**Utility (2 tools)**
- `radiant_get_protocol_info` — Protocol type reference
- `radiant_validate_address` — Address validation

### 6 Resources (static reference data):
- `radiant://docs/chain-overview` — Blockchain overview
- `radiant://docs/opcodes` — Opcode reference (including V2)
- `radiant://docs/protocols` — Glyph protocols, dMint algorithms, DAA modes
- `radiant://docs/network-params` — Network parameters (JSON)
- `radiant://docs/sdk-quickstart` — radiantjs quick start guide
- `radiant://docs/knowledge-base` — Comprehensive AI knowledge base (13 sections)

### REST API (25 HTTP endpoints)

The same functionality is also available as a standard REST API for any HTTP client:

```bash
# Start REST server
npm run start:rest

# Query chain info
curl http://localhost:3080/api/chain

# Get address balance
curl http://localhost:3080/api/address/1A1zP1.../balance

# Search tokens
curl http://localhost:3080/api/tokens/search?q=mytoken

# Full endpoint list
curl http://localhost:3080/api
```

OpenAPI 3.1 spec: `docs/openapi.yaml`

## Installation

```bash
npm install
npm run build
```

## Configuration

### Windsurf / Cascade

Add to your MCP settings (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "radiant": {
      "command": "node",
      "args": ["/path/to/radiant-mcp-server/dist/index.js"],
      "env": {
        "ELECTRUMX_HOST": "electrumx.radiant4people.com",
        "ELECTRUMX_PORT": "50012",
        "ELECTRUMX_SSL": "true",
        "RADIANT_NETWORK": "mainnet"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "radiant": {
      "command": "node",
      "args": ["/path/to/radiant-mcp-server/dist/index.js"],
      "env": {
        "ELECTRUMX_HOST": "electrumx.radiant4people.com",
        "ELECTRUMX_PORT": "50012",
        "ELECTRUMX_SSL": "true"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ELECTRUMX_HOST` | `electrumx.radiant4people.com` | ElectrumX server hostname |
| `ELECTRUMX_PORT` | `50012` | ElectrumX server port |
| `ELECTRUMX_SSL` | `true` | Use TLS connection |
| `RADIANT_NETWORK` | `mainnet` | Network: `mainnet` or `testnet` |
| `PORT` | `3080` | REST API server port |
| `CORS_ORIGIN` | `*` | CORS allowed origin |

## Development

```bash
# MCP server (development)
npm run dev

# REST API server (development)
npm run dev:rest

# Type check
npm run lint

# Build
npm run build

# Run tests
npx tsx test/smoke.ts   # MCP smoke test (no network)
npx tsx test/live.ts    # MCP live test (ElectrumX)
npx tsx test/rest.ts    # REST API test (ElectrumX)
```

## Architecture

```
AI Agent (Windsurf/Claude/Cursor)       Web App / HTTP Client
       │ MCP Protocol (stdio)                  │ HTTP/REST
       ▼                                       ▼
radiant-mcp-server (index.ts)      radiant-rest-api (rest.ts)
  ├── Tools (29)                     ├── 25 REST endpoints
  ├── Resources (6)                  ├── OpenAPI 3.1 spec
  └──────────┬───────────────────────┘
             │ Shared ElectrumX Client (TCP/TLS)
             ▼
      RXinDexer / ElectrumX
        (Glyph + WAVE + Swap + dMint APIs)
```

## About Radiant

Radiant (RXD) is a Layer 1 UTXO proof-of-work blockchain with native digital asset support. Key features:
- **SHA512/256d** mining algorithm
- **Glyph** token standard (FT, NFT, dMint, WAVE names, 11 protocol types)
- **256 MB** blocks, **5 minute** block time
- **21 billion** max supply
- **V2 opcodes** (block 410,000+): OP_BLAKE3, OP_K12, OP_LSHIFT, OP_RSHIFT, OP_2MUL, OP_2DIV

## License

MIT
