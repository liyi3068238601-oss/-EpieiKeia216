import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';

let size = 0;
const chunks = [];
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 65536) throw new Error('P01 Hook input too large');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const packetBytes = await readFile(process.env.P01_PACKET_PATH);
if (packetBytes.length > 16000) throw new Error('P01 packet too large');
const packet = JSON.parse(packetBytes.toString('utf8'));
const transcript = await readFile(input.transcriptPath ?? input.transcript_path);
if (transcript.length > 4 * 1024 * 1024) throw new Error('P01 transcript too large');
const event = input.hookEventName;
await appendFile(process.env.P01_HOOK_LOG, JSON.stringify({ event, phase: packet.phase,
  packet_sha256: createHash('sha256').update(packetBytes).digest('hex'),
  transcript_bytes: transcript.length,
  transcript_sha256: createHash('sha256').update(transcript).digest('hex'),
}) + '\n');
const output = { hookEventName: event };
if (event === 'PreToolUse') {
  const path = input.toolInput?.file_path;
  const rel = typeof path === 'string' ? relative(packet.fixture, resolve(path)) : '..';
  output.permissionDecision = input.toolName === 'Read' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel)
    ? 'allow' : 'deny';
  output.permissionDecisionReason = 'P01 synthetic read-only fixture scope';
} else if (event === 'PostToolUseFailure') {
  output.additionalContext = 'P01_TOOL_FAILED: report the failed or denied operation honestly. A model assertion is not completion evidence.';
} else {
  output.additionalContext = 'P01_ROLE_CONTEXT ' + JSON.stringify(packet);
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
