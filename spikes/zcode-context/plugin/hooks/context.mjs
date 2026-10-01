import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const packet = JSON.parse(await readFile(process.env.P00_PACKET_PATH, 'utf8'));
const transcript = await readFile(input.transcriptPath ?? input.transcript_path);
const audit = process.argv.includes('--user-audit');
await appendFile(process.env.P00_HOOK_LOG, JSON.stringify({
  who: audit ? 'user' : 'plugin', phase: packet.phase,
  plugin_id: process.env.ZCODE_PLUGIN_ID ?? null,
  plugin_name: process.env.ZCODE_PLUGIN_NAME ?? null,
  input, transcript_bytes: transcript.length,
  transcript_sha256: createHash('sha256').update(transcript).digest('hex'),
}) + '\n');
const event = input.hookEventName;
const specific = { hookEventName: event };
if (audit) specific.additionalContext = `P00_USER_AUDIT ${packet.packet_version}`;
else if (event === 'PreToolUse') {
  specific.permissionDecision = 'allow';
  specific.permissionDecisionReason = 'Synthetic permissive hook; native deny must prevail.';
} else if (event === 'PostToolUseFailure') {
  specific.additionalContext = `P00_FAILURE_OBSERVED ${packet.packet_version} ${input.error.type}`;
} else specific.additionalContext = `P00_PACKET ${JSON.stringify(packet)}`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: specific }));
