# Radiant Python Client

Auto-generated typed Python client for the Radiant Blockchain REST API (OpenAPI v1.1.0).

## Installation

```bash
pip install requests
```

## Quick Start

```python
from radiant_client import RadiantClient

client = RadiantClient("http://localhost:3080/api")

# Blockchain
info = client.get_chain_info()
print(f"Height: {info['height']}")

# Address
balance = client.get_balance("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
print(f"Confirmed: {balance['confirmed']['rxd']} RXD")

# Glyph Tokens
results = client.search_tokens("PEPE")
for token in results["results"]:
    print(f"  {token.get('ticker')} — {token.get('name')}")

# dMint
contracts = client.get_dmint_contracts()
for c in contracts.get("contracts", []):
    print(f"  {c['ticker']} algo={c['algorithm']} diff={c['difficulty']}")

# WAVE
resolved = client.resolve_wave_name("alice")
print(resolved)

# Swap
orders = client.get_swap_orders(sell="rxd", buy="<token_ref>")

# AI Primitives
proof = client.create_inference_proof(
    model_hash="a" * 64,
    input_hash="b" * 64,
    output_hex="deadbeef",
)
print(f"Commitment: {proof['commitment']}")
```

## API Coverage

| Category | Methods |
|----------|---------|
| Blockchain | `get_chain_info`, `get_block_header`, `get_transaction`, `decode_transaction`, `broadcast_transaction`, `estimate_fee` |
| Address | `get_balance`, `get_utxos`, `get_history`, `list_tokens` |
| Glyph | `get_token`, `get_token_metadata`, `get_token_history`, `search_tokens`, `get_tokens_by_type` |
| dMint | `get_dmint_contracts`, `get_dmint_contract`, `get_dmint_by_algorithm`, `get_most_profitable_dmint` |
| WAVE | `resolve_wave_name`, `check_wave_available`, `get_wave_subdomains`, `get_wave_stats` |
| Swap | `get_swap_orders`, `get_swap_history` |
| Utility | `validate_address`, `get_protocol_info`, `get_health` |
| Wallet | `create_wallet`, `restore_wallet` |
| AI Primitives | `create_inference_proof`, `verify_inference_proof`, `build_agent_profile`, `resolve_agent_identity`, `check_token_access`, `open_channel`, `update_channel`, `build_data_asset`, `search_data_assets` |

**Total: 35 methods** covering all ~48 REST endpoints.

## Error Handling

```python
from radiant_client import RadiantClient, RadiantAPIError

client = RadiantClient()
try:
    tx = client.get_transaction("0" * 64)
except RadiantAPIError as e:
    print(f"Error {e.status_code}: {e.detail}")
```

## Custom Headers

```python
client = RadiantClient(
    base_url="https://api.example.com",
    headers={"Authorization": "Bearer <token>"},
    timeout=60,
)
```

## Source

Generated from `docs/openapi.yaml` (OpenAPI 3.1.0, v1.1.0).
