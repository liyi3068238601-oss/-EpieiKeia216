import { isJsonValue } from "../../contracts/src/json-value.js";

export const CHARACTER_FIELDS = Object.freeze([
  "identity", "voice", "values", "boundaries", "canon", "examples",
] as const);
export type CharacterFieldName = (typeof CHARACTER_FIELDS)[number];
export const FIELD_BYTE_LIMITS = Object.freeze({
  identity: 2048, voice: 2048, values: 2048,
  boundaries: 4096, canon: 4096, examples: 4096,
});
export const SOURCE_PATH = "docs/research/P01/persona-from-mofox-v3.md";
export const SOURCE_SHA256 = "d17b290e585cc8954321e4a0e6881823dcd221e6dff8e82223a506090ab3433f";

export interface CharacterField {
  readonly text: string;
  readonly source: {
    readonly path: typeof SOURCE_PATH;
    readonly sha256: typeof SOURCE_SHA256;
    readonly section: string;
  };
  readonly license: string;
  readonly fiction: boolean;
}
export interface CharacterAsset {
  readonly schemaVersion: 1;
  readonly id: "xiadie";
  readonly displayName: "遐蝶";
  readonly version: "v3";
  readonly fields: Readonly<Record<CharacterFieldName, CharacterField>>;
}
export type CharacterErrorCode =
  | "IDENTITY_MISMATCH" | "ASSET_INVALID" | "ASSET_FILE_MISSING"
  | "ASSET_PATH_ESCAPE" | "ASSET_TOO_LARGE" | "ASSET_HASH_MISMATCH";
export class CharacterAssetError extends Error {
  constructor(readonly code: CharacterErrorCode, message: string) {
    super(message);
    this.name = "CharacterAssetError";
  }
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) {
    throw new CharacterAssetError("ASSET_INVALID", "Character asset shape is invalid");
  }
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new CharacterAssetError("ASSET_INVALID", "Character text must be nonempty");
  }
  if (new TextEncoder().encode(value).byteLength > limit) {
    throw new CharacterAssetError("ASSET_TOO_LARGE", "Character text exceeds its UTF-8 byte limit");
  }
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate a JSON value; only loadCharacter also authenticates its approved bytes. */
export function validateCharacterAsset(value: unknown): CharacterAsset {
  if (!isJsonValue(value)) {
    throw new CharacterAssetError("ASSET_INVALID", "Character asset must be plain JSON");
  }
  const asset = objectWithKeys(value, ["schemaVersion", "id", "displayName", "version", "fields"]);
  if (asset.id !== "xiadie" || asset.displayName !== "遐蝶" || asset.version !== "v3") {
    throw new CharacterAssetError("IDENTITY_MISMATCH", "The approved character identity is required");
  }
  if (asset.schemaVersion !== 1) {
    throw new CharacterAssetError("ASSET_INVALID", "Unsupported character schema");
  }
  const fields = objectWithKeys(asset.fields, CHARACTER_FIELDS);
  let totalBytes = 0;
  for (const name of CHARACTER_FIELDS) {
    const field = objectWithKeys(fields[name], ["text", "source", "license", "fiction"]);
    boundedText(field.text, FIELD_BYTE_LIMITS[name]);
    totalBytes += new TextEncoder().encode(field.text).byteLength;
    const source = objectWithKeys(field.source, ["path", "sha256", "section"]);
    boundedText(source.section, 256);
    if (source.path !== SOURCE_PATH || source.sha256 !== SOURCE_SHA256 ||
        field.license !== (name === "examples"
          ? "project-authored-style-examples; local-use"
          : "user-approved-persona-adaptation; public-rights-unverified") ||
        field.fiction !== (name !== "boundaries")) {
      throw new CharacterAssetError("ASSET_INVALID", "Character provenance metadata is invalid");
    }
  }
  if (totalBytes > 16_384) {
    throw new CharacterAssetError("ASSET_TOO_LARGE", "Character text exceeds its total byte limit");
  }
  // Every property was checked above; JsonValue has no structural interface mapping.
  return freezeDeep(value) as unknown as CharacterAsset;
}
