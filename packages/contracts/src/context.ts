import type { JsonValue } from "./json-value.js";

export const CONTEXT_PACKET_SCHEMA_VERSION = 1 as const;
export const CONTEXT_PACKET_BUDGET_METHOD = "utf8-byte-upper-bound" as const;

export type ContextInstructionField =
  | "identity"
  | "voice"
  | "values"
  | "boundaries"
  | "examples";

/** A trace label only; source references do not grant instruction authority. */
export type ContextSourceRef = string;

export interface ContextInstructionRecord {
  readonly field: ContextInstructionField;
  readonly text: string;
  readonly source_refs: readonly ContextSourceRef[];
}

/** JSON data whose authority comes only from its packet partition. */
export interface ContextDataRecord {
  readonly source_refs: readonly ContextSourceRef[];
  readonly value: JsonValue;
}

export interface ContextPacketBudget {
  readonly max_tokens: number;
  readonly method: typeof CONTEXT_PACKET_BUDGET_METHOD;
}

/** Runtime-neutral serialized contract; native system and project rules remain outside it. */
export interface ContextPacket {
  readonly schema_version: typeof CONTEXT_PACKET_SCHEMA_VERSION;
  readonly scope: string;
  readonly version: string;
  readonly budget: ContextPacketBudget;
  readonly instruction: readonly ContextInstructionRecord[];
  readonly state: readonly ContextDataRecord[];
  readonly evidence: readonly ContextDataRecord[];
  readonly content: readonly ContextDataRecord[];
}

/** There is intentionally no instruction input. The builder fills that partition from an approved role snapshot. */
export interface ContextPacketInput {
  readonly scope: string;
  readonly version: string;
  readonly max_tokens: number;
  readonly state: readonly ContextDataRecord[];
  readonly evidence: readonly ContextDataRecord[];
  readonly content: readonly ContextDataRecord[];
}
