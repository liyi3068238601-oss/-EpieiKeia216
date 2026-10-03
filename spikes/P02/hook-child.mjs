import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const MAX_STDIN = 128 * 1024;
const MAX_TRANSCRIPT = 512 * 1024;
const SOURCE_ROOT = process.env.P02_U02_ZCODE_SOURCE;
const INPUT_MODULE = path.join(SOURCE_ROOT || "", "apps/zcode-cli/packages/core/dist/hooks/configured-runner-input.js");
const OUTPUT_DIR = process.env.P02_U02_OUTPUT_DIR;
const TEMP_ROOT = process.env.TEMP || process.env.TMP;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function readStdinBounded(limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > limit) throw new Error("stdin_over_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
async function readTranscriptBounded(filename) {
  const first = await fs.promises.lstat(filename);
  if (first.isSymbolicLink() || !first.isFile()) throw new Error("transcript_not_regular");
  const handle = await fs.promises.open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("transcript_not_regular");
    if (before.size > MAX_TRANSCRIPT) throw new Error("transcript_over_limit");
    const chunks = [];
    let total = 0;
    while (total <= MAX_TRANSCRIPT) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_TRANSCRIPT + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_TRANSCRIPT) throw new Error("transcript_over_limit");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) {
      throw new Error("transcript_changed_during_read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
function redactJsonl(bytes, input) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("transcript_incomplete_line");
  const lines = text.slice(0, -1).split("\n");
  const messages = lines.map((line) => {
    const parsed = JSON.parse(line);
    const message = parsed && typeof parsed === "object" ? parsed.message : undefined;
    if (!message || typeof message.role !== "string" || !Array.isArray(message.content)) {
      throw new Error("transcript_shape_invalid");
    }
    const content = message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return {
      role: message.role,
      text: "[REDACTED]",
      textBytes: Buffer.byteLength(content, "utf8"),
      textSha256: sha256(Buffer.from(content, "utf8")),
    };
  });
  if (input.hookEventName === "UserPromptSubmit") {
    if (messages.length !== 1 || messages[0].role !== "user") throw new Error("prompt_transcript_not_single_current_message");
    if (messages[0].textBytes !== Buffer.byteLength(String(input.prompt), "utf8")) throw new Error("prompt_transcript_length_mismatch");
    const rawPrompt = lines.length === 1
      ? (() => {
          const parsed = JSON.parse(lines[0]);
          return (parsed.message.content || [])
            .filter((part) => part && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
        })()
      : undefined;
    if (rawPrompt !== String(input.prompt)) throw new Error("prompt_transcript_content_mismatch");
  }
  return { version: 1, messages };
}
async function runHook() {
  const stdin = await readStdinBounded(MAX_STDIN);
  const input = JSON.parse(stdin.toString("utf8"));
  if (!input || input.hookEventName !== "UserPromptSubmit" || typeof input.transcriptPath !== "string") {
    throw new Error("hook_input_invalid");
  }
  const bytes = await readTranscriptBounded(input.transcriptPath);
  const redacted = redactJsonl(bytes, input);
  const redactedBytes = Buffer.from(JSON.stringify(redacted), "utf8");
  const capture = {
    rawRetained: false,
    source: {
      locator: input.transcriptPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
    redactedSnapshot: redacted,
    redactedSnapshotSha256: sha256(redactedBytes),
  };
  if (!OUTPUT_DIR || !path.isAbsolute(OUTPUT_DIR)) throw new Error("capture_output_dir_missing");
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const name = path.basename(process.env.P02_U02_CAPTURE_NAME || "capture.json");
  await fs.promises.writeFile(path.join(OUTPUT_DIR, name), JSON.stringify(capture, null, 2) + "\n", { flag: "wx" });
  const scenario = process.env.P02_U02_SCENARIO || "success";
  if (scenario === "block") {
    process.stderr.write("P02 synthetic exit-2 block\n");
    process.exitCode = 2;
    return;
  }
  if (scenario === "fail") {
    process.stderr.write("P02 synthetic nonzero failure\n");
    process.exitCode = 7;
    return;
  }
  process.stdout.write(JSON.stringify({ continue: true, additionalContext: "P02 synthetic Hook success" }) + "\n");
}
async function runFaultWrite() {
  if (!TEMP_ROOT || !OUTPUT_DIR || !SOURCE_ROOT) throw new Error("fault_environment_missing");
  const before = new Set(await fs.promises.readdir(TEMP_ROOT));
  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function(file, ...args) {
    if (path.basename(String(file)) === "transcript.jsonl") throw new Error("synthetic_write_fault");
    return Reflect.apply(originalWriteFile, this, [file, ...args]);
  };
  syncBuiltinESMExports();
  let rejected = false;
  let errorCode = "";
  let cleanupReturned = false;
  try {
    const input = {
      cwd: process.cwd(),
      hookEventName: "UserPromptSubmit",
      mode: "plan",
      prompt: "SYNTHETIC_FAULT_INPUT",
      sessionId: "synthetic-session",
      timestamp: new Date(0).toISOString(),
      traceId: "synthetic-trace",
      turnId: "synthetic-turn",
    };
    const { createCompatibleHookStdin } = await import(pathToFileURL(INPUT_MODULE).href);
    const result = await createCompatibleHookStdin(input);
    cleanupReturned = true;
    await result.cleanup();
  } catch (error) {
    rejected = true;
    errorCode = String(error && error.message || error);
  } finally {
    fs.promises.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }
  const after = await fs.promises.readdir(TEMP_ROOT);
  const created = after.filter((name) => name.startsWith("zcode-hook-") && !before.has(name));
  const record = {
    fault: "writeFile(transcript.jsonl) throws after native mkdtemp",
    rejected,
    cleanupReturned,
    errorCode,
    leakedDirectoriesObservedBeforeProbeCleanup: created,
    provesCleanupGap: rejected && !cleanupReturned && created.length > 0,
    cleanup: "probe removes only directories created during this isolated child",
  };
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(OUTPUT_DIR, "fault-write.json"), JSON.stringify(record, null, 2) + "\n");
  for (const name of created) await fs.promises.rm(path.join(TEMP_ROOT, name), { recursive: true, force: true });
  process.stdout.write(JSON.stringify(record) + "\n");
  if (!record.provesCleanupGap) process.exitCode = 3;
}

if (process.argv[2] === "fault-write") {
  await runFaultWrite();
} else {
  try {
    await runHook();
  } catch (error) {
    process.stderr.write("HOOK_CHILD_ERROR " + String(error && error.message || error) + "\n");
    process.exitCode = 8;
  }
}
