"""
Radiant Blockchain REST API Client — Python

Auto-generated from OpenAPI spec v1.1.0
Source: docs/openapi.yaml

Usage:
    from radiant_client import RadiantClient

    client = RadiantClient("http://localhost:3080/api")
    info = client.get_chain_info()
    print(info["height"])

Requirements:
    pip install requests
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union
import requests


class RadiantAPIError(Exception):
    """Raised when the API returns a non-2xx status code."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"HTTP {status_code}: {detail}")


class RadiantClient:
    """Typed Python client for the Radiant Blockchain REST API."""

    def __init__(
        self,
        base_url: str = "http://localhost:3080/api",
        timeout: int = 30,
        headers: Optional[Dict[str, str]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        if headers:
            self.session.headers.update(headers)

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        resp = self.session.request(
            method, url, params=params, json=json_body, timeout=self.timeout
        )
        if not resp.ok:
            detail = resp.text
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                pass
            raise RadiantAPIError(resp.status_code, detail)
        return resp.json()

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, params=params)

    def _post(self, path: str, json_body: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("POST", path, json_body=json_body)

    # =========================================================================
    # Blockchain
    # =========================================================================

    def get_chain_info(self) -> Dict[str, Any]:
        """Get blockchain status (height, network, ticker)."""
        return self._get("/chain")

    def get_block_header(self, height: int) -> Dict[str, Any]:
        """Get block header by height."""
        return self._get(f"/block/{height}")

    def get_transaction(self, txid: str) -> Dict[str, Any]:
        """Get transaction details by txid."""
        return self._get(f"/tx/{txid}")

    def decode_transaction(self, txid: str) -> Dict[str, Any]:
        """Decode a transaction (verbose)."""
        return self._get(f"/tx/{txid}/decode")

    def broadcast_transaction(self, raw_tx: str) -> Dict[str, Any]:
        """Broadcast a signed raw transaction."""
        return self._post("/tx", {"raw_tx": raw_tx})

    def estimate_fee(self, blocks: int = 6) -> Dict[str, Any]:
        """Estimate transaction fee for confirmation within N blocks."""
        return self._get("/fee", {"blocks": blocks})

    # =========================================================================
    # Address
    # =========================================================================

    def get_balance(self, address: str) -> Dict[str, Any]:
        """Get RXD balance for an address (confirmed + unconfirmed)."""
        return self._get(f"/address/{address}/balance")

    def get_utxos(self, address: str) -> Dict[str, Any]:
        """List unspent outputs for an address."""
        return self._get(f"/address/{address}/utxos")

    def get_history(self, address: str) -> Dict[str, Any]:
        """Get transaction history for an address."""
        return self._get(f"/address/{address}/history")

    def list_tokens(self, address: str, limit: int = 100) -> Dict[str, Any]:
        """List Glyph tokens held by an address."""
        return self._get(f"/address/{address}/tokens", {"limit": limit})

    # =========================================================================
    # Glyph Tokens
    # =========================================================================

    def get_token(self, ref: str) -> Dict[str, Any]:
        """Get Glyph token info by reference (txid_vout)."""
        return self._get(f"/token/{ref}")

    def get_token_metadata(self, ref: str) -> Dict[str, Any]:
        """Get full CBOR metadata for a token."""
        return self._get(f"/token/{ref}/metadata")

    def get_token_history(
        self, ref: str, limit: int = 100, offset: int = 0
    ) -> Dict[str, Any]:
        """Get transaction history for a token."""
        return self._get(f"/token/{ref}/history", {"limit": limit, "offset": offset})

    def search_tokens(
        self,
        query: str,
        protocols: Optional[str] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """Search tokens by name or ticker."""
        params: Dict[str, Any] = {"q": query, "limit": limit}
        if protocols:
            params["protocols"] = protocols
        return self._get("/tokens/search", params)

    def get_tokens_by_type(
        self, type_id: int, limit: int = 100, offset: int = 0
    ) -> Dict[str, Any]:
        """List tokens by type (1=FT, 2=NFT, 3=DAT, 4=dMint, etc.)."""
        return self._get(
            f"/tokens/type/{type_id}", {"limit": limit, "offset": offset}
        )

    # =========================================================================
    # dMint
    # =========================================================================

    def get_dmint_contracts(self, format: str = "extended") -> Any:
        """List active dMint contracts."""
        return self._get("/dmint/contracts", {"format": format})

    def get_dmint_contract(self, ref: str) -> Dict[str, Any]:
        """Get dMint contract details by reference."""
        return self._get(f"/dmint/contract/{ref}")

    def get_dmint_by_algorithm(self, algo_id: int) -> Any:
        """Get dMint contracts filtered by mining algorithm (0=SHA256D, 1=BLAKE3, 2=K12)."""
        return self._get(f"/dmint/algorithm/{algo_id}")

    def get_most_profitable_dmint(self, limit: int = 10) -> Any:
        """Get most profitable dMint contracts sorted by reward/difficulty."""
        return self._get("/dmint/profitable", {"limit": limit})

    # =========================================================================
    # WAVE Naming
    # =========================================================================

    def resolve_wave_name(self, name: str) -> Dict[str, Any]:
        """Resolve a WAVE name to zone records and owner."""
        return self._get(f"/wave/resolve/{name}")

    def check_wave_available(self, name: str) -> Dict[str, Any]:
        """Check if a WAVE name is available for registration."""
        return self._get(f"/wave/available/{name}")

    def get_wave_subdomains(
        self, name: str, limit: int = 100, offset: int = 0
    ) -> Dict[str, Any]:
        """List subdomains of a WAVE name."""
        return self._get(
            f"/wave/{name}/subdomains", {"limit": limit, "offset": offset}
        )

    def get_wave_stats(self) -> Dict[str, Any]:
        """Get WAVE naming system statistics."""
        return self._get("/wave/stats")

    # =========================================================================
    # Swap / DEX
    # =========================================================================

    def get_swap_orders(
        self,
        sell: str,
        buy: str,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Get open swap orders for a trading pair."""
        return self._get(
            "/swap/orders",
            {"sell": sell, "buy": buy, "limit": limit, "offset": offset},
        )

    def get_swap_history(
        self, ref: str, limit: int = 100, offset: int = 0
    ) -> Dict[str, Any]:
        """Get trade history for a token."""
        return self._get(
            "/swap/history", {"ref": ref, "limit": limit, "offset": offset}
        )

    # =========================================================================
    # Utility
    # =========================================================================

    def validate_address(self, address: str) -> Dict[str, Any]:
        """Validate a Radiant address and get its type/scripthash."""
        return self._get(f"/validate/{address}")

    def get_protocol_info(self) -> Dict[str, Any]:
        """Get Glyph protocol type definitions."""
        return self._get("/protocols")

    def get_health(self) -> Dict[str, Any]:
        """Check ElectrumX connection health."""
        return self._get("/health")

    # =========================================================================
    # Wallet
    # =========================================================================

    def create_wallet(
        self,
        network: str = "mainnet",
        mnemonic: bool = False,
        word_count: int = 12,
        passphrase: str = "",
        path: str = "m/44'/0'/0'/0/0",
    ) -> Dict[str, Any]:
        """Generate a new Radiant wallet (optional BIP39 mnemonic)."""
        return self._post(
            "/wallet/create",
            {
                "network": network,
                "mnemonic": mnemonic,
                "word_count": word_count,
                "passphrase": passphrase,
                "path": path,
            },
        )

    def restore_wallet(
        self,
        mnemonic_phrase: str,
        network: str = "mainnet",
        passphrase: str = "",
        path: str = "m/44'/0'/0'/0/0",
    ) -> Dict[str, Any]:
        """Restore wallet from BIP39 mnemonic (12-24 words)."""
        return self._post(
            "/wallet/restore",
            {
                "mnemonic": mnemonic_phrase,
                "network": network,
                "passphrase": passphrase,
                "path": path,
            },
        )

    # =========================================================================
    # Phase 5: AI Primitives
    # =========================================================================

    def create_inference_proof(
        self, model_hash: str, input_hash: str, output_hex: str
    ) -> Dict[str, Any]:
        """Create a blake3 inference proof commitment."""
        return self._post(
            "/inference/proof",
            {
                "model_hash": model_hash,
                "input_hash": input_hash,
                "output_hex": output_hex,
            },
        )

    def verify_inference_proof(
        self,
        model_hash: str,
        input_hash: str,
        output_hex: str,
        commitment: str,
    ) -> Dict[str, Any]:
        """Verify an inference proof commitment."""
        return self._post(
            "/inference/verify",
            {
                "model_hash": model_hash,
                "input_hash": input_hash,
                "output_hex": output_hex,
                "commitment": commitment,
            },
        )

    def build_agent_profile(
        self,
        address: str,
        description: str,
        capabilities: List[str],
        api_url: Optional[str] = None,
        pricing: Optional[str] = None,
        model: Optional[str] = None,
        wave_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build an AI agent identity profile."""
        body: Dict[str, Any] = {
            "address": address,
            "description": description,
            "capabilities": capabilities,
        }
        if api_url:
            body["api_url"] = api_url
        if pricing:
            body["pricing"] = pricing
        if model:
            body["model"] = model
        if wave_name:
            body["wave_name"] = wave_name
        return self._post("/identity/profile", body)

    def resolve_agent_identity(self, name: str) -> Dict[str, Any]:
        """Resolve an AI agent identity from WAVE name."""
        return self._get(f"/identity/resolve/{name}")

    def check_token_access(
        self, address: str, token_ref: str, min_balance: int = 1
    ) -> Dict[str, Any]:
        """Check token-gated service access."""
        return self._get(
            f"/access/check/{address}/{token_ref}",
            {"min_balance": min_balance},
        )

    def open_channel(
        self,
        channel_id: str,
        agent_a: str,
        agent_b: str,
        capacity: int,
        timeout_blocks: int = 1008,
    ) -> Dict[str, Any]:
        """Create initial micropayment channel state."""
        return self._post(
            "/channel/open",
            {
                "channel_id": channel_id,
                "agent_a": agent_a,
                "agent_b": agent_b,
                "capacity": capacity,
                "timeout_blocks": timeout_blocks,
            },
        )

    def update_channel(
        self,
        channel_id: str,
        agent_a: str,
        agent_b: str,
        capacity: int,
        balance_a: int,
        balance_b: int,
        payment_amount: int,
        nonce: int = 0,
        timeout_blocks: int = 1008,
    ) -> Dict[str, Any]:
        """Update micropayment channel state (transfer A→B)."""
        return self._post(
            "/channel/update",
            {
                "channel_id": channel_id,
                "agent_a": agent_a,
                "agent_b": agent_b,
                "capacity": capacity,
                "balance_a": balance_a,
                "balance_b": balance_b,
                "payment_amount": payment_amount,
                "nonce": nonce,
                "timeout_blocks": timeout_blocks,
            },
        )

    def build_data_asset(
        self,
        ref: str,
        asset_type: str,
        name: str,
        content_hash: str,
        description: Optional[str] = None,
        size_bytes: Optional[int] = None,
        mime_type: Optional[str] = None,
        price: int = 0,
        derived_from: Optional[List[str]] = None,
        license: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Build Glyph NFT metadata for a data marketplace asset."""
        body: Dict[str, Any] = {
            "ref": ref,
            "type": asset_type,
            "name": name,
            "content_hash": content_hash,
            "price": price,
        }
        if description:
            body["description"] = description
        if size_bytes is not None:
            body["size_bytes"] = size_bytes
        if mime_type:
            body["mime_type"] = mime_type
        if derived_from:
            body["derived_from"] = derived_from
        if license:
            body["license"] = license
        return self._post("/marketplace/asset", body)

    def search_data_assets(
        self,
        query: str,
        asset_type: Optional[str] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """Search the data marketplace."""
        params: Dict[str, Any] = {"q": query, "limit": limit}
        if asset_type:
            params["type"] = asset_type
        return self._get("/marketplace/search", params)
