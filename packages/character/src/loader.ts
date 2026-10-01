import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CharacterAssetError, SOURCE_PATH, SOURCE_SHA256, validateCharacterAsset } from "./schema.js";
import type { CharacterAsset } from "./schema.js";

// Content approval is held in code, outside model-editable asset manifests.
export const APPROVED_CHARACTER = Object.freeze({
  id: "xiadie", version: "v3",
  manifestSha256: "3bedae784adae2182f3396cccbc3c91663fe96a58d18373481fbb7155d888f62",
  contentSha256: "a688c669c4f556495131ac69cdc868a5b2ee93614eff814fc0793b1690c99bb4",
  contentBytes: 5580,
});
const approvedSnapshots = new WeakSet<object>();

/** Provenance metadata or schema validity alone never grants instruction authority. */
export function isApprovedCharacter(value: unknown): value is CharacterAsset {
  return value !== null && typeof value === "object" && approvedSnapshots.has(value);
}

function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readBounded(root: string, relative: string, limit: number): Buffer {
  const filename = path.resolve(root, relative);
  if (!inside(root, filename)) {
    throw new CharacterAssetError("ASSET_PATH_ESCAPE", "Character path is outside the asset root");
  }
  let descriptor: number | undefined;
  try {
    let current = root;
    for (const segment of path.relative(root, filename).split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) {
        throw new CharacterAssetError("ASSET_PATH_ESCAPE", "Character asset links are not supported");
      }
    }
    const canonical = realpathSync(filename);
    if (!inside(root, canonical)) {
      throw new CharacterAssetError("ASSET_PATH_ESCAPE", "Character real path is outside the asset root");
    }
    descriptor = openSync(canonical, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new CharacterAssetError("ASSET_INVALID", "Character asset must be a regular file");
    if (stat.size > limit) throw new CharacterAssetError("ASSET_TOO_LARGE", "Character file exceeds its byte limit");
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > limit) throw new CharacterAssetError("ASSET_TOO_LARGE", "Character file grew beyond its byte limit");
    return buffer.subarray(0, count);
  } catch (error) {
    if (error instanceof CharacterAssetError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new CharacterAssetError("ASSET_FILE_MISSING", "A required character asset is missing");
    }
    throw new CharacterAssetError("ASSET_INVALID", "Character asset could not be read");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new CharacterAssetError("ASSET_INVALID", "Character asset JSON is invalid"); }
}

/** Host-only read API. Failure rejects the turn; there is no generic identity fallback. */
export function loadCharacter(assetRoot: string, id = "xiadie", version = "v3"): CharacterAsset {
  if (id !== APPROVED_CHARACTER.id || version !== APPROVED_CHARACTER.version) {
    throw new CharacterAssetError("IDENTITY_MISMATCH", "The approved character and version are required");
  }
  let root: string;
  try { root = realpathSync(path.resolve(assetRoot)); }
  catch { throw new CharacterAssetError("ASSET_FILE_MISSING", "The character asset root is unavailable"); }
  const manifestBytes = readBounded(root, "xiadie/v3/manifest.json", 4096);
  if (digest(manifestBytes) !== APPROVED_CHARACTER.manifestSha256) {
    throw new CharacterAssetError("ASSET_HASH_MISMATCH", "Character manifest differs from its approved bytes");
  }
  const manifest = parseJson(manifestBytes) as Record<string, unknown> | null;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.schemaVersion !== 1 || manifest.id !== id || manifest.version !== version ||
      manifest.contentFile !== "persona.json" || manifest.contentBytes !== APPROVED_CHARACTER.contentBytes ||
      manifest.contentSha256 !== APPROVED_CHARACTER.contentSha256 ||
      manifest.sourcePath !== SOURCE_PATH || manifest.sourceSha256 !== SOURCE_SHA256) {
    throw new CharacterAssetError("ASSET_INVALID", "Character manifest metadata is invalid");
  }
  const content = readBounded(root, "xiadie/v3/persona.json", 32_768);
  if (content.length !== APPROVED_CHARACTER.contentBytes || digest(content) !== APPROVED_CHARACTER.contentSha256) {
    throw new CharacterAssetError("ASSET_HASH_MISMATCH", "Character content differs from its approved bytes");
  }
  const asset = validateCharacterAsset(parseJson(content));
  approvedSnapshots.add(asset);
  return asset;
}
