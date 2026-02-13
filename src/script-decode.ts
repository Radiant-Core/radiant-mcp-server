/**
 * Offline script decoder — disassembles raw script hex into human-readable opcodes.
 * Covers standard Bitcoin opcodes, Radiant-specific opcodes, introspection, and V2 opcodes.
 */

const OPCODE_MAP: Record<number, string> = {
  // Constants
  0x00: "OP_0", 0x4c: "OP_PUSHDATA1", 0x4d: "OP_PUSHDATA2", 0x4e: "OP_PUSHDATA4",
  0x4f: "OP_1NEGATE", 0x50: "OP_RESERVED",
  0x51: "OP_1", 0x52: "OP_2", 0x53: "OP_3", 0x54: "OP_4",
  0x55: "OP_5", 0x56: "OP_6", 0x57: "OP_7", 0x58: "OP_8",
  0x59: "OP_9", 0x5a: "OP_10", 0x5b: "OP_11", 0x5c: "OP_12",
  0x5d: "OP_13", 0x5e: "OP_14", 0x5f: "OP_15", 0x60: "OP_16",
  // Flow control
  0x61: "OP_NOP", 0x62: "OP_VER", 0x63: "OP_IF", 0x64: "OP_NOTIF",
  0x65: "OP_VERIF", 0x66: "OP_VERNOTIF", 0x67: "OP_ELSE", 0x68: "OP_ENDIF",
  0x69: "OP_VERIFY", 0x6a: "OP_RETURN",
  // Stack
  0x6b: "OP_TOALTSTACK", 0x6c: "OP_FROMALTSTACK", 0x6d: "OP_2DROP", 0x6e: "OP_2DUP",
  0x6f: "OP_3DUP", 0x70: "OP_2OVER", 0x71: "OP_2ROT", 0x72: "OP_2SWAP",
  0x73: "OP_IFDUP", 0x74: "OP_DEPTH", 0x75: "OP_DROP", 0x76: "OP_DUP",
  0x77: "OP_NIP", 0x78: "OP_OVER", 0x79: "OP_PICK", 0x7a: "OP_ROLL",
  0x7b: "OP_ROT", 0x7c: "OP_SWAP", 0x7d: "OP_TUCK",
  // Splice
  0x7e: "OP_CAT", 0x7f: "OP_SPLIT", 0x80: "OP_NUM2BIN", 0x81: "OP_BIN2NUM",
  0x82: "OP_SIZE",
  // Bitwise logic
  0x83: "OP_INVERT", 0x84: "OP_AND", 0x85: "OP_OR", 0x86: "OP_XOR",
  0x87: "OP_EQUAL", 0x88: "OP_EQUALVERIFY", 0x89: "OP_RESERVED1", 0x8a: "OP_RESERVED2",
  // Arithmetic
  0x8b: "OP_1ADD", 0x8c: "OP_1SUB", 0x8d: "OP_2MUL", 0x8e: "OP_2DIV",
  0x8f: "OP_NEGATE", 0x90: "OP_ABS", 0x91: "OP_NOT", 0x92: "OP_0NOTEQUAL",
  0x93: "OP_ADD", 0x94: "OP_SUB", 0x95: "OP_MUL", 0x96: "OP_DIV", 0x97: "OP_MOD",
  0x98: "OP_LSHIFT", 0x99: "OP_RSHIFT",
  0x9a: "OP_BOOLAND", 0x9b: "OP_BOOLOR",
  0x9c: "OP_NUMEQUAL", 0x9d: "OP_NUMEQUALVERIFY",
  0x9e: "OP_NUMNOTEQUAL", 0x9f: "OP_LESSTHAN",
  0xa0: "OP_GREATERTHAN", 0xa1: "OP_LESSTHANOREQUAL", 0xa2: "OP_GREATERTHANOREQUAL",
  0xa3: "OP_MIN", 0xa4: "OP_MAX", 0xa5: "OP_WITHIN",
  // Crypto
  0xa6: "OP_RIPEMD160", 0xa7: "OP_SHA1", 0xa8: "OP_SHA256",
  0xa9: "OP_HASH160", 0xaa: "OP_HASH256",
  0xab: "OP_CODESEPARATOR", 0xac: "OP_CHECKSIG", 0xad: "OP_CHECKSIGVERIFY",
  0xae: "OP_CHECKMULTISIG", 0xaf: "OP_CHECKMULTISIGVERIFY",
  // NOP
  0xb0: "OP_NOP1", 0xb1: "OP_CHECKLOCKTIMEVERIFY", 0xb2: "OP_CHECKSEQUENCEVERIFY",
  0xb3: "OP_NOP4", 0xb4: "OP_NOP5", 0xb5: "OP_NOP6",
  0xb6: "OP_NOP7", 0xb7: "OP_NOP8", 0xb8: "OP_NOP9", 0xb9: "OP_NOP10",
  // BCH data sig
  0xba: "OP_CHECKDATASIG", 0xbb: "OP_CHECKDATASIGVERIFY",
  0xbc: "OP_REVERSEBYTES",
  // Radiant state
  0xbd: "OP_STATESEPARATOR", 0xbe: "OP_STATESEPARATORINDEX_UTXO", 0xbf: "OP_STATESEPARATORINDEX_OUTPUT",
  // Introspection
  0xc0: "OP_INPUTINDEX", 0xc1: "OP_ACTIVEBYTECODE", 0xc2: "OP_TXVERSION",
  0xc3: "OP_TXINPUTCOUNT", 0xc4: "OP_TXOUTPUTCOUNT", 0xc5: "OP_TXLOCKTIME",
  0xc6: "OP_UTXOVALUE", 0xc7: "OP_UTXOBYTECODE",
  0xc8: "OP_OUTPOINTTXHASH", 0xc9: "OP_OUTPOINTINDEX",
  0xca: "OP_INPUTBYTECODE", 0xcb: "OP_INPUTSEQUENCENUMBER",
  0xcc: "OP_OUTPUTVALUE", 0xcd: "OP_OUTPUTBYTECODE",
  // Radiant hash
  0xce: "OP_SHA512_256", 0xcf: "OP_HASH512_256",
  // Radiant references
  0xd0: "OP_PUSHINPUTREF", 0xd1: "OP_REQUIREINPUTREF",
  0xd2: "OP_DISALLOWPUSHINPUTREF", 0xd3: "OP_DISALLOWPUSHINPUTREFSIBLING",
  0xd4: "OP_REFHASHDATASUMMARY_UTXO", 0xd5: "OP_REFHASHVALUESUM_UTXOS",
  0xd6: "OP_REFHASHDATASUMMARY_OUTPUT", 0xd7: "OP_REFHASHVALUESUM_OUTPUTS",
  0xd8: "OP_PUSHINPUTREFSINGLETON", 0xd9: "OP_REFTYPE_UTXO", 0xda: "OP_REFTYPE_OUTPUT",
  0xdb: "OP_REFVALUESUM_UTXOS", 0xdc: "OP_REFVALUESUM_OUTPUTS",
  0xdd: "OP_REFOUTPUTCOUNT_UTXOS", 0xde: "OP_REFOUTPUTCOUNT_OUTPUTS",
  0xdf: "OP_REFOUTPUTCOUNTZEROVALUED_UTXOS", 0xe0: "OP_REFOUTPUTCOUNTZEROVALUED_OUTPUTS",
  0xe1: "OP_REFDATASUMMARY_UTXO", 0xe2: "OP_REFDATASUMMARY_OUTPUT",
  // Radiant code script
  0xe3: "OP_CODESCRIPTHASHVALUESUM_UTXOS", 0xe4: "OP_CODESCRIPTHASHVALUESUM_OUTPUTS",
  0xe5: "OP_CODESCRIPTHASHOUTPUTCOUNT_UTXOS", 0xe6: "OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS",
  0xe7: "OP_CODESCRIPTHASHZEROVALUEDOUTPUTCOUNT_UTXOS", 0xe8: "OP_CODESCRIPTHASHZEROVALUEDOUTPUTCOUNT_OUTPUTS",
  0xe9: "OP_CODESCRIPTBYTECODE_UTXO", 0xea: "OP_CODESCRIPTBYTECODE_OUTPUT",
  0xeb: "OP_STATESCRIPTBYTECODE_UTXO", 0xec: "OP_STATESCRIPTBYTECODE_OUTPUT",
  0xed: "OP_PUSH_TX_STATE",
  // V2 opcodes
  0xee: "OP_BLAKE3", 0xef: "OP_K12",
};

// Opcodes that consume a 36-byte inline reference
const REF_OPCODES = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd8]);

interface DecodedOp {
  offset: number;
  opcode: string;
  hex: string;
  data?: string;
  dataLength?: number;
}

interface DecodeResult {
  script_hex: string;
  length: number;
  opcodes: DecodedOp[];
  asm: string;
  summary: {
    total_ops: number;
    data_pushes: number;
    has_state_separator: boolean;
    has_references: boolean;
    has_v2_opcodes: boolean;
    script_type: string;
  };
}

function identifyScriptType(ops: DecodedOp[]): string {
  const asm = ops.map((o) => o.opcode).join(" ");
  if (asm.startsWith("OP_DUP OP_HASH160") && asm.includes("OP_EQUALVERIFY OP_CHECKSIG")) return "P2PKH";
  if (asm.startsWith("OP_HASH160") && asm.endsWith("OP_EQUAL")) return "P2SH";
  if (ops[0]?.opcode === "OP_RETURN") return "OP_RETURN (data carrier)";
  if (asm.includes("OP_STATESEPARATOR")) return "Radiant stateful contract";
  if (asm.includes("OP_PUSHINPUTREF") || asm.includes("OP_PUSHINPUTREFSINGLETON")) return "Radiant reference script";
  if (asm.includes("OP_CHECKDATASIG")) return "Data signature script";
  if (asm.includes("OP_CHECKMULTISIG")) return "Multisig script";
  return "Custom script";
}

export function decodeScript(hexString: string): DecodeResult {
  // Strip whitespace and 0x prefix
  const hex = hexString.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }

  const bytes = Buffer.from(hex, "hex");
  const ops: DecodedOp[] = [];
  let i = 0;

  while (i < bytes.length) {
    const offset = i;
    const byte = bytes[i++];

    // Direct data push (1-75 bytes)
    if (byte >= 0x01 && byte <= 0x4b) {
      const len = byte;
      const data = bytes.subarray(i, i + len).toString("hex");
      ops.push({ offset, opcode: `<${len}>`, hex: byte.toString(16).padStart(2, "0"), data, dataLength: len });
      i += len;
      continue;
    }

    // OP_PUSHDATA1
    if (byte === 0x4c && i < bytes.length) {
      const len = bytes[i++];
      const data = bytes.subarray(i, i + len).toString("hex");
      ops.push({ offset, opcode: "OP_PUSHDATA1", hex: "4c", data, dataLength: len });
      i += len;
      continue;
    }

    // OP_PUSHDATA2
    if (byte === 0x4d && i + 1 < bytes.length) {
      const len = bytes[i] | (bytes[i + 1] << 8);
      i += 2;
      const data = bytes.subarray(i, i + len).toString("hex");
      ops.push({ offset, opcode: "OP_PUSHDATA2", hex: "4d", data, dataLength: len });
      i += len;
      continue;
    }

    // OP_PUSHDATA4
    if (byte === 0x4e && i + 3 < bytes.length) {
      const len = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      i += 4;
      const data = bytes.subarray(i, i + len).toString("hex");
      ops.push({ offset, opcode: "OP_PUSHDATA4", hex: "4e", data, dataLength: len });
      i += len;
      continue;
    }

    // Reference opcodes consume 36-byte inline data
    if (REF_OPCODES.has(byte)) {
      const name = OPCODE_MAP[byte] || `OP_UNKNOWN_0x${byte.toString(16)}`;
      const refData = bytes.subarray(i, i + 36).toString("hex");
      ops.push({ offset, opcode: name, hex: byte.toString(16).padStart(2, "0"), data: refData, dataLength: 36 });
      i += 36;
      continue;
    }

    // Named opcode
    const name = OPCODE_MAP[byte] || `OP_UNKNOWN_0x${byte.toString(16)}`;
    ops.push({ offset, opcode: name, hex: byte.toString(16).padStart(2, "0") });
  }

  const asm = ops.map((o) => o.data ? `${o.opcode} ${o.data}` : o.opcode).join(" ");
  const hasRefs = ops.some((o) => REF_OPCODES.has(parseInt(o.hex, 16)));
  const hasStateSep = ops.some((o) => o.hex === "bd");
  const hasV2 = ops.some((o) => {
    const b = parseInt(o.hex, 16);
    return b === 0xee || b === 0xef || b === 0x98 || b === 0x99 || b === 0x8d || b === 0x8e;
  });

  return {
    script_hex: hex,
    length: bytes.length,
    opcodes: ops,
    asm,
    summary: {
      total_ops: ops.filter((o) => !o.data || REF_OPCODES.has(parseInt(o.hex, 16))).length,
      data_pushes: ops.filter((o) => o.data && !REF_OPCODES.has(parseInt(o.hex, 16))).length,
      has_state_separator: hasStateSep,
      has_references: hasRefs,
      has_v2_opcodes: hasV2,
      script_type: identifyScriptType(ops),
    },
  };
}
