import {
  CONTEXT_PACKET_BUDGET_METHOD,
  CONTEXT_PACKET_SCHEMA_VERSION,
} from "../../contracts/src/context.js";
import type {
  ContextDataRecord,
  ContextInstructionField,
  ContextInstructionRecord,
  ContextPacket,
  ContextPacketInput,
} from "../../contracts/src/context.js";
import { isApprovedCharacter } from "../../character/src/loader.js";
import type { CharacterAsset } from "../../character/src/schema.js";

export type {
  ContextDataRecord,
  ContextInstructionField,
  ContextInstructionRecord,
  ContextPacket,
  ContextPacketInput,
} from "../../contracts/src/context.js";

export type ContextPacketErrorCode =
  | "UNAPPROVED_CHARACTER"
  | "INVALID_INPUT"
  | "BUDGET_EXCEEDED"
  | "UNAUTHORIZED_PACKET";

export class ContextPacketError extends Error {
  constructor(readonly code: ContextPacketErrorCode, message: string) {
    super(message);
    this.name = "ContextPacketError";
  }
}

const INPUT_KEYS = ["scope", "version", "max_tokens", "state", "evidence", "content"] as const;
const RECORD_KEYS = ["source_refs", "value"] as const;
const INSTRUCTION_FIELDS = ["identity", "voice", "values", "boundaries", "examples"] as const satisfies readonly ContextInstructionField[];
const MAX_SCOPE_BYTES = 128;
const MAX_VERSION_BYTES = 64;
const MAX_SOURCE_REF_BYTES = 512;
const MAX_SOURCE_REFS_PER_RECORD = 16;
const MAX_RECORDS_PER_PARTITION = 128;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INPUT_NODES = 20_000;
const MAX_JSON_DEPTH = 64;
const MAX_BUDGET = 1_048_576;

const builtPackets = new WeakSet<object>();
const renderedPackets = new WeakMap<object, string>();
const encoder = new TextEncoder();

/** Construct a packet only from the U04-approved character snapshot and JSON-only dynamic data. */
export function buildContextPacket(character: unknown, input: ContextPacketInput): ContextPacket {
  if (!isApprovedCharacter(character)) {
    throw new ContextPacketError("UNAPPROVED_CHARACTER", "An approved character snapshot is required");
  }
  const counter: InputCounter = { bytes: 0, nodes: 0 };
  let snapshot: import("../../contracts/src/json-value.js").JsonValue;
  try {
    snapshot = snapshotJson(input, counter, 0);
  } catch (error) {
    if (error instanceof ContextPacketError) throw error;
    invalid("Context input could not be safely snapshotted");
  }
  const validated = validateInput(snapshot);
  const instruction = INSTRUCTION_FIELDS.map((field) => instructionFrom(character, field));
  const canon = character.fields.canon;
  const canonRecord: ContextDataRecord = {
    source_refs: [sourceReference(canon.source.path, canon.source.section, canon.source.sha256)],
    value: { kind: "fictional-character-canon", text: canon.text },
  };
  const packet = freezeDeep({
    schema_version: CONTEXT_PACKET_SCHEMA_VERSION,
    scope: validated.scope,
    version: validated.version,
    budget: {
      max_tokens: validated.max_tokens,
      method: CONTEXT_PACKET_BUDGET_METHOD,
    },
    instruction,
    state: [canonRecord, ...validated.state],
    evidence: validated.evidence,
    content: validated.content,
  } satisfies ContextPacket);

  const rendered = serializePacket(packet);
  if (encoder.encode(rendered).byteLength > packet.budget.max_tokens) {
    throw new ContextPacketError("BUDGET_EXCEEDED", "The complete context packet exceeds max_tokens");
  }
  builtPackets.add(packet);
  renderedPackets.set(packet, rendered);
  return packet;
}

/** Return only a packet created in this process from an approved role snapshot. */
export function renderContextPacket(packet: unknown): string {
  if (packet === null || typeof packet !== "object" || !builtPackets.has(packet)) {
    throw new ContextPacketError("UNAUTHORIZED_PACKET", "Packet must be rebuilt from approved role and data");
  }
  const rendered = renderedPackets.get(packet);
  if (rendered === undefined) {
    throw new ContextPacketError("UNAUTHORIZED_PACKET", "Packet rendering provenance is unavailable");
  }
  return rendered;
}

interface ValidatedInput {
  readonly scope: string;
  readonly version: string;
  readonly max_tokens: number;
  readonly state: readonly ContextDataRecord[];
  readonly evidence: readonly ContextDataRecord[];
  readonly content: readonly ContextDataRecord[];
}

interface InputCounter {
  bytes: number;
  nodes: number;
}

function validateInput(value: unknown): ValidatedInput {
  const input = objectWithKeys(value, INPUT_KEYS);
  const counter: InputCounter = { bytes: 0, nodes: 0 };
  const scope = boundedString(input.scope, "scope", MAX_SCOPE_BYTES, counter);
  const version = boundedString(input.version, "version", MAX_VERSION_BYTES, counter);
  if (!Number.isSafeInteger(input.max_tokens) || (input.max_tokens as number) < 1 || (input.max_tokens as number) > MAX_BUDGET) {
    invalid("max_tokens must be a positive safe integer within the supported limit");
  }
  const max_tokens = input.max_tokens as number;
  const state = records(input.state, "state", counter);
  const evidence = records(input.evidence, "evidence", counter);
  const content = records(input.content, "content", counter);
  return { scope, version, max_tokens, state, evidence, content };
}

function records(value: unknown, partition: string, counter: InputCounter): readonly ContextDataRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS_PER_PARTITION) {
    invalid(`${partition} must be an array within the record limit`);
  }
  return value.map((record) => {
    const item = objectWithKeys(record, RECORD_KEYS);
    if (!Array.isArray(item.source_refs) || item.source_refs.length === 0 || item.source_refs.length > MAX_SOURCE_REFS_PER_RECORD) {
      invalid(`${partition} records require a bounded, non-empty source_refs array`);
    }
    const source_refs = item.source_refs.map((ref) => boundedString(ref, "source_refs entry", MAX_SOURCE_REF_BYTES, counter));
    return { source_refs, value: item.value as import("../../contracts/src/json-value.js").JsonValue };
  });
}

function instructionFrom(character: CharacterAsset, field: ContextInstructionField): ContextInstructionRecord {
  const item = character.fields[field];
  return {
    field,
    text: item.text,
    source_refs: [sourceReference(item.source.path, item.source.section, item.source.sha256)],
  };
}

function sourceReference(path: string, section: string, sha256: string): string {
  return `${path}#${section}@sha256:${sha256}`;
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    invalid("Context object shape is invalid");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxBytes: number, counter: InputCounter): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || value.length > maxBytes) {
    invalid(`${label} must be a non-empty bounded string`);
  }
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength > maxBytes) invalid(`${label} exceeds its UTF-8 byte limit`);
  addSize(byteLength, counter);
  return value;
}

function snapshotJson(value: unknown, counter: InputCounter, depth: number): import("../../contracts/src/json-value.js").JsonValue {
  if (depth > MAX_JSON_DEPTH) invalid("Context JSON exceeds the maximum depth");
  counter.nodes += 1;
  if (counter.nodes > MAX_INPUT_NODES) invalid("Context JSON exceeds the node limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_INPUT_BYTES) invalid("Context JSON string exceeds the input limit");
    addSize(encoder.encode(value).byteLength, counter);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Context JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid("Context arrays must be plain arrays");
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_INPUT_NODES ||
        keys.length !== (length as number) + 1 || !keys.includes("length")) {
      invalid("Context arrays must be dense plain JSON arrays");
    }
    const clone: import("../../contracts/src/json-value.js").JsonValue[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        invalid("Context arrays cannot contain holes or accessors");
      }
      clone.push(snapshotJson(descriptor.value, counter, depth + 1));
    }
    return clone;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("Context objects must be plain JSON objects");
    const keys = Reflect.ownKeys(value);
    const clone = Object.create(null) as Record<string, import("../../contracts/src/json-value.js").JsonValue>;
    for (const key of keys) {
      if (typeof key !== "string") invalid("Context JSON cannot contain symbol keys");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        invalid("Context objects cannot contain accessors or hidden properties");
      }
      if (key.length > MAX_INPUT_BYTES) invalid("Context JSON key exceeds the input limit");
      addSize(encoder.encode(key).byteLength, counter);
      clone[key] = snapshotJson(descriptor.value, counter, depth + 1);
    }
    return clone;
  }
  invalid("Context JSON contains a non-JSON value");
}

function addSize(size: number, counter: InputCounter): void {
  counter.bytes += size;
  if (counter.bytes > MAX_INPUT_BYTES) invalid("Context input exceeds its UTF-8 byte limit");
}

function stableJson(value: import("../../contracts/src/json-value.js").JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as { readonly [key: string]: import("../../contracts/src/json-value.js").JsonValue };
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key]!)}`).join(",")}}`;
}

function serializePacket(packet: ContextPacket): string {
  // Keep the four authority partitions in a fixed order; nested data keys are sorted.
  const json = (value: unknown) => stableJson(value as import("../../contracts/src/json-value.js").JsonValue);
  return `{` +
    `"schema_version":${packet.schema_version},` +
    `"scope":${JSON.stringify(packet.scope)},` +
    `"version":${JSON.stringify(packet.version)},` +
    `"budget":${json(packet.budget)},` +
    `"instruction":${json(packet.instruction)},` +
    `"state":${json(packet.state)},` +
    `"evidence":${json(packet.evidence)},` +
    `"content":${json(packet.content)}` +
    `}`;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(message: string): never {
  throw new ContextPacketError("INVALID_INPUT", message);
}
