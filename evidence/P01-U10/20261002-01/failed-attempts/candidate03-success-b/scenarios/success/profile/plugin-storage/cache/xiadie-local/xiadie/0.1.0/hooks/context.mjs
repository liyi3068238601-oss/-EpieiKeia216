import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const ASSET_DIGEST = "a688c669c4f556495131ac69cdc868a5b2ee93614eff814fc0793b1690c99bb4";

async function main() {
  const rawInput = await readStdin(MAX_INPUT_BYTES);
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawInput));
  const event = selectAlias(input, "hookEventName", "hook_event_name");
  const sessionId = selectAlias(input, "sessionId", "session_id");
  const turnId = selectAlias(input, "turnId", "turn_id");
  const transcriptPath = selectAlias(input, "transcriptPath", "transcript_path");
  const expectedEvent = process.env.XIA_DIE_HOOK_EVENT;
  if (event !== expectedEvent || event !== "UserPromptSubmit" ||
      typeof sessionId !== "string" || sessionId.length === 0 ||
      typeof turnId !== "string" || turnId.length === 0 ||
      typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    throw new Error("Native Hook input did not match the host admission ticket");
  }

  const moduleRoot = requiredEnv("XIA_DIE_HOST_MODULE_ROOT");
  const assetRoot = requiredEnv("XIA_DIE_APPROVED_ASSET_ROOT");
  const nonce = requiredEnv("XIA_DIE_TICKET_NONCE");
  const loaderUrl = pathToFileURL(path.join(moduleRoot, "packages", "character", "src", "loader.js"));
  const contextUrl = pathToFileURL(path.join(moduleRoot, "packages", "context", "src", "index.js"));
  const { loadCharacter } = await import(loaderUrl.href);
  const { buildContextPacket, renderContextPacket } = await import(contextUrl.href);
  const character = loadCharacter(assetRoot);
  const packet = buildContextPacket(character, {
    scope: `zcode-session:${sessionId}`,
    version: `u06-turn:${nonce}`,
    max_tokens: 12_000,
    state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }],
    evidence: [],
    content: [],
  });
  const additionalContext = renderContextPacket(packet);
  const transcript = readBoundedTranscript(transcriptPath);
  const receipt = {
    version: 1,
    nonce,
    event,
    sessionId,
    turnId,
    packetSha256: digest(Buffer.from(additionalContext, "utf8")),
    transcriptBytes: transcript.bytes,
    transcriptSha256: transcript.sha256,
    character: { id: character.id, version: character.version, contentSha256: ASSET_DIGEST },
  };
  process.stdout.write(JSON.stringify({ additionalContext, xiadieReceipt: receipt }));
}

function selectAlias(record, camel, snake) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("Hook input must be an object");
  const left = record[camel];
  const right = record[snake];
  if (left !== undefined && right !== undefined && left !== right) throw new Error(`Hook aliases disagree: ${camel}`);
  return left ?? right;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing trusted host variable: ${name}`);
  return value;
}

async function readStdin(limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Hook stdin exceeds its byte bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function readBoundedTranscript(filename) {
  let descriptor;
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new Error("transcript must not be a symlink");
    const canonical = realpathSync(filename);
    descriptor = openSync(canonical, "r");
    if (!fstatSync(descriptor).isFile()) throw new Error("transcript must be a regular file");
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > MAX_TRANSCRIPT_BYTES) throw new Error("transcript exceeds its byte bound");
    return { bytes: count, sha256: digest(buffer.subarray(0, count)) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  process.stderr.write(`Xiadie Hook rejected input: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
