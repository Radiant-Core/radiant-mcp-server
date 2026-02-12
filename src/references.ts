/**
 * Static reference data for Radiant blockchain.
 * Used by MCP resources and tool descriptions.
 */

export const NETWORK_PARAMS = {
  mainnet: {
    name: "Radiant Mainnet",
    ticker: "RXD",
    addressPrefix: 0x00,
    p2shPrefix: 0x05,
    wifPrefix: 0x80,
    maxSupply: 21_000_000_000,
    decimals: 8,
    blockTime: 300, // 5 minutes
    halvingInterval: 210_000,
    currentReward: 25_000,
    maxBlockSize: 256_000_000, // 256 MB
    maxTxSize: 12_000_000, // 12 MB (consensus)
    miningAlgorithm: "SHA512/256d",
    v2ActivationHeight: 410_000,
    defaultElectrumxPort: 50012,
  },
  testnet: {
    name: "Radiant Testnet",
    ticker: "tRXD",
    addressPrefix: 0x6f,
    p2shPrefix: 0xc4,
    wifPrefix: 0xef,
    maxSupply: 21_000_000_000,
    decimals: 8,
    blockTime: 300,
    halvingInterval: 210_000,
    currentReward: 25_000,
    maxBlockSize: 256_000_000,
    maxTxSize: 12_000_000,
    miningAlgorithm: "SHA512/256d",
    v2ActivationHeight: 410_000,
    defaultElectrumxPort: 60012,
  },
};

export const OPCODES = {
  // Standard opcodes (subset relevant to AI/developers)
  OP_DUP: { hex: "0x76", description: "Duplicate top stack item" },
  OP_HASH160: { hex: "0xa9", description: "SHA256 + RIPEMD160" },
  OP_HASH256: { hex: "0xaa", description: "Double SHA256" },
  OP_EQUALVERIFY: { hex: "0x88", description: "Check equality, fail if not" },
  OP_CHECKSIG: { hex: "0xac", description: "Verify ECDSA signature" },
  OP_CHECKMULTISIG: { hex: "0xae", description: "Verify M-of-N signatures" },
  OP_RETURN: { hex: "0x6a", description: "Mark output as unspendable data carrier" },
  OP_CHECKDATASIG: { hex: "0xba", description: "Verify signature against arbitrary data" },
  OP_CHECKDATASIGVERIFY: { hex: "0xbb", description: "CHECKDATASIG + VERIFY" },
  // Radiant-specific opcodes
  OP_PUSHINPUTREF: { hex: "0xd0", description: "Push and validate input reference (36 bytes)" },
  OP_REQUIREINPUTREF: { hex: "0xd1", description: "Require specific input reference exists" },
  OP_DISALLOWPUSHINPUTREF: { hex: "0xd2", description: "Prevent reference propagation" },
  OP_DISALLOWPUSHINPUTREFSIBLING: { hex: "0xd3", description: "Prevent sibling reference use" },
  OP_REFHASHDATASUMMARY_UTXO: { hex: "0xd4", description: "Hash summary of UTXO ref data" },
  OP_REFHASHVALUESUM_UTXOS: { hex: "0xd5", description: "Sum of values for ref UTXOs" },
  OP_REFHASHDATASUMMARY_OUTPUT: { hex: "0xd6", description: "Hash summary of output ref data" },
  OP_REFHASHVALUESUM_OUTPUTS: { hex: "0xd7", description: "Sum of values for ref outputs" },
  OP_PUSHINPUTREFSINGLETON: { hex: "0xd8", description: "Push singleton input reference" },
  OP_REFTYPE_UTXO: { hex: "0xd9", description: "Get reference type from UTXO" },
  OP_REFTYPE_OUTPUT: { hex: "0xda", description: "Get reference type from output" },
  OP_REFOUTPUTCOUNT_UTXOS: { hex: "0xe1", description: "Count outputs with ref in UTXOs" },
  OP_REFOUTPUTCOUNT_OUTPUTS: { hex: "0xe2", description: "Count outputs with ref in outputs" },
  OP_REFOUTPUTCOUNTZEROVALUED_UTXOS: { hex: "0xe3", description: "Count zero-valued ref UTXOs" },
  OP_REFOUTPUTCOUNTZEROVALUED_OUTPUTS: { hex: "0xe4", description: "Count zero-valued ref outputs" },
  OP_STATESEPARATOR: { hex: "0xbd", description: "Separate code from state in scripts" },
  OP_STATESEPARATORINDEX_UTXO: { hex: "0xbe", description: "Get state separator index from UTXO" },
  OP_STATESEPARATORINDEX_OUTPUT: { hex: "0xbf", description: "Get state separator index from output" },
  // V2 opcodes (block 410,000+)
  OP_BLAKE3: { hex: "0xee", description: "BLAKE3 hash (32-byte output, max 1024-byte input)" },
  OP_K12: { hex: "0xef", description: "KangarooTwelve hash (32-byte output)" },
  OP_LSHIFT: { hex: "0x98", description: "Left bit shift (re-enabled V2)" },
  OP_RSHIFT: { hex: "0x99", description: "Right bit shift (re-enabled V2)" },
  OP_2MUL: { hex: "0x8d", description: "Multiply by 2 (re-enabled V2)" },
  OP_2DIV: { hex: "0x8e", description: "Divide by 2 (re-enabled V2)" },
  // Introspection opcodes
  OP_INPUTINDEX: { hex: "0xc0", description: "Push current input index" },
  OP_ACTIVEBYTECODE: { hex: "0xc1", description: "Push executing script bytecode" },
  OP_TXVERSION: { hex: "0xc2", description: "Push transaction version" },
  OP_TXINPUTCOUNT: { hex: "0xc3", description: "Push number of inputs" },
  OP_TXOUTPUTCOUNT: { hex: "0xc4", description: "Push number of outputs" },
  OP_TXLOCKTIME: { hex: "0xc5", description: "Push transaction locktime" },
  OP_UTXOVALUE: { hex: "0xc6", description: "Push UTXO value by index" },
  OP_UTXOBYTECODE: { hex: "0xc7", description: "Push UTXO scriptPubKey by index" },
  OP_OUTPOINTTXHASH: { hex: "0xc8", description: "Push outpoint txid by input index" },
  OP_OUTPOINTINDEX: { hex: "0xc9", description: "Push outpoint vout by input index" },
  OP_INPUTBYTECODE: { hex: "0xca", description: "Push input scriptSig by index" },
  OP_INPUTSEQUENCENUMBER: { hex: "0xcb", description: "Push input sequence number by index" },
  OP_OUTPUTVALUE: { hex: "0xcc", description: "Push output value by index" },
  OP_OUTPUTBYTECODE: { hex: "0xcd", description: "Push output scriptPubKey by index" },
};

export const GLYPH_PROTOCOLS = {
  1: { name: "GLYPH_FT", description: "Fungible Token" },
  2: { name: "GLYPH_NFT", description: "Non-Fungible Token" },
  3: { name: "GLYPH_DAT", description: "Data Storage" },
  4: { name: "GLYPH_DMINT", description: "Decentralized Minting (PoW token distribution)" },
  5: { name: "GLYPH_MUT", description: "Mutable State (updateable metadata)" },
  6: { name: "GLYPH_BURN", description: "Explicit Burn" },
  7: { name: "GLYPH_CONTAINER", description: "Container / Collection (parent-only)" },
  8: { name: "GLYPH_ENCRYPTED", description: "Encrypted Content" },
  9: { name: "GLYPH_TIMELOCK", description: "Timelocked Reveal" },
  10: { name: "GLYPH_AUTHORITY", description: "Issuer Authority" },
  11: { name: "GLYPH_WAVE", description: "WAVE Naming System" },
};

export const DMINT_ALGORITHMS = {
  0: { name: "SHA256D", description: "Double SHA-256 (v1 default)" },
  1: { name: "BLAKE3", description: "BLAKE3 hash (V2, on-chain via OP_BLAKE3)" },
  2: { name: "K12", description: "KangarooTwelve (V2, on-chain via OP_K12)" },
  3: { name: "ARGON2ID_LIGHT", description: "Argon2id light (deferred)" },
  4: { name: "RANDOMX_LIGHT", description: "RandomX light (deferred)" },
};

export const DAA_MODES = {
  0x00: { name: "fixed", description: "Static difficulty, no adjustment" },
  0x01: { name: "epoch", description: "Epoch-based adjustment (Bitcoin-style)" },
  0x02: { name: "asert", description: "ASERT-lite with OP_LSHIFT/OP_RSHIFT" },
  0x03: { name: "lwma", description: "LWMA (Linear Weighted Moving Average)" },
  0x04: { name: "schedule", description: "Pre-defined difficulty schedule" },
};

export function getChainOverview(): string {
  const p = NETWORK_PARAMS.mainnet;
  return `# Radiant Blockchain (RXD)

**Layer 1 UTXO proof-of-work blockchain** with native digital asset support.

## Key Parameters
- Ticker: ${p.ticker}
- Mining: ${p.miningAlgorithm}
- Block time: ${p.blockTime / 60} minutes
- Block size: ${p.maxBlockSize / 1_000_000} MB
- Max supply: ${p.maxSupply.toLocaleString()} RXD
- Block reward: ${p.currentReward.toLocaleString()} RXD (halves every ${p.halvingInterval.toLocaleString()} blocks)
- Decimals: ${p.decimals}

## Unique Features
- **UTXO model** with induction proofs and reference system
- **64-bit arithmetic** in script
- **Transaction introspection** opcodes
- **Glyph token standard** (11 protocol types: FT, NFT, dMint, WAVE names, etc.)
- **V2 opcodes** (block ${p.v2ActivationHeight.toLocaleString()}+): OP_BLAKE3, OP_K12, OP_LSHIFT, OP_RSHIFT, OP_2MUL, OP_2DIV
- **256 MB blocks** for high throughput
- **Low fees** (~0.001 RXD per transaction)

## Ecosystem Tools
- **radiantjs** — JavaScript SDK for transaction construction and signing
- **RXinDexer** — ElectrumX-based indexer with Glyph/WAVE/Swap APIs
- **RadiantScript** — High-level smart contract compiler
- **Photonic Wallet** — Desktop/web wallet with Glyph token support
- **Glyph-miner** — GPU miner for dMint tokens (SHA256d, BLAKE3, K12)
`;
}

export function getProtocolReference(): string {
  let text = "# Glyph Protocol IDs\n\n";
  text += "| ID | Name | Description |\n|---|------|-------------|\n";
  for (const [id, info] of Object.entries(GLYPH_PROTOCOLS)) {
    text += `| ${id} | ${info.name} | ${info.description} |\n`;
  }

  text += "\n# dMint Algorithm IDs\n\n";
  text += "| ID | Name | Description |\n|---|------|-------------|\n";
  for (const [id, info] of Object.entries(DMINT_ALGORITHMS)) {
    text += `| ${id} | ${info.name} | ${info.description} |\n`;
  }

  text += "\n# DAA Modes\n\n";
  text += "| ID | Name | Description |\n|---|------|-------------|\n";
  for (const [id, info] of Object.entries(DAA_MODES)) {
    text += `| ${id} | ${info.name} | ${info.description} |\n`;
  }

  return text;
}

export function getOpcodeReference(): string {
  let text = "# Radiant Opcodes Reference\n\n";
  text += "| Opcode | Hex | Description |\n|--------|-----|-------------|\n";
  for (const [name, info] of Object.entries(OPCODES)) {
    text += `| ${name} | ${info.hex} | ${info.description} |\n`;
  }
  return text;
}
