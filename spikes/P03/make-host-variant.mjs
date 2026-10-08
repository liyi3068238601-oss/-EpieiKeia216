// An explicit U02-only experiment on the existing host/Hook seam; no production patch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = 'E:\\Xiadie\\Xiadie';
const SOURCE = path.join(ROOT, '.runtime/P01/desktop-source');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function once(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Expected exactly one pinned seam: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
async function binding(file) { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: digest(bytes) }; }

/**
 * Build after tsc. Pass projectMemoryDataProvider(sessionId, operation) to the returned host.
 * The synchronous callback returns exactly {state: [], evidence: [], content: []}.
 * Hook data is copied from the validated frozen packet, so callback mutation cannot change the ticket.
 * Install hookPath bytes only into the owned Native fixture's installed context.mjs copy.
 */
export async function buildHostVariant({ repositoryRoot, outputDir }) {
  assert.ok(path.resolve(repositoryRoot).startsWith(path.join(ROOT, '.runtime/P03/worktrees') + path.sep));
  assert.ok(path.resolve(outputDir).startsWith(path.join(ROOT, '.runtime/P03/experiments') + path.sep));
  await mkdir(outputDir); // fail if an old build already occupies the path
  const hostInput = path.join(repositoryRoot, 'dist/packages/adapters/zcode/src/host.js');
  const hookInput = path.join(repositoryRoot, 'plugins/xiadie/hooks/context.mjs');
  let host = await readFile(hostInput, 'utf8');
  let hook = await readFile(hookInput, 'utf8');
  host = once(host, 'const packet = buildContextPacket(character, {',
    `const projectMemoryData = input.projectMemoryDataProvider?.(sessionId, operation) ?? { state: [], evidence: [], content: [] };
            if (projectMemoryData === null || typeof projectMemoryData !== "object" ||
                Object.keys(projectMemoryData).sort().join(",") !== "content,evidence,state") {
                throw new Error("Project memory provider must return only bounded data partitions synchronously");
            }
            const packet = buildContextPacket(character, {`);
  host = once(host,
    'state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }],\n                evidence: [],\n                content: [],',
    'state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }, ...projectMemoryData.state],\n                evidence: projectMemoryData.evidence,\n                content: projectMemoryData.content,');
  host = once(host, 'characterDigest: APPROVED_CHARACTER.contentSha256,',
    'characterDigest: APPROVED_CHARACTER.contentSha256,\n                projectMemoryData: { state: packet.state.slice(2), evidence: packet.evidence, content: packet.content },');
  host = once(host, 'XIA_DIE_PLUGIN_DATA_ROOT: input.dataRoot,',
    'XIA_DIE_PLUGIN_DATA_ROOT: input.dataRoot,\n                XIA_DIE_PROJECT_MEMORY_DATA: JSON.stringify(ticket.projectMemoryData),');
  hook = once(hook, 'const packet = buildContextPacket(character, {',
    `const projectMemoryData = JSON.parse(requiredEnv("XIA_DIE_PROJECT_MEMORY_DATA"));
  if (projectMemoryData === null || typeof projectMemoryData !== "object" ||
      Object.keys(projectMemoryData).sort().join(",") !== "content,evidence,state") {
    throw new Error("Project memory Hook data must contain exactly three data partitions");
  }
  const packet = buildContextPacket(character, {`);
  hook = once(hook,
    'state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }],\n    evidence: [],\n    content: [],',
    'state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }, ...projectMemoryData.state],\n    evidence: projectMemoryData.evidence,\n    content: projectMemoryData.content,');
  const hostPath = path.join(outputDir, 'host.mjs');
  const hookPath = path.join(outputDir, 'context.mjs');
  const esbuild = createRequire(path.join(SOURCE, 'package.json'))('esbuild');
  const built = await esbuild.build({ stdin: { contents: host, loader: 'js', resolveDir: path.dirname(hostInput), sourcefile: 'p03-host-seam-experiment.js' },
    outfile: hostPath, bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true, logLevel: 'silent' });
  await writeFile(path.join(outputDir, 'host-variant-source.js'), host);
  await writeFile(hookPath, hook);
  const manifest = { schema: 'p03-u02-host-variant/v1', inputs: [await binding(hostInput), await binding(hookInput)],
    outputs: [await binding(hostPath), await binding(hookPath), await binding(path.join(outputDir, 'host-variant-source.js'))],
    tool: { name: 'esbuild', version: esbuild.version },
    changes: ['per-admission synchronous trusted data callback', 'validated packet data copied to ticket',
      'trusted bounded Hook environment data', 'Hook reassembles same packet with original identity, nonce and transcript receipt checks'],
    limitations: ['Isolated spike only; not production code', 'Bundle/import inputs recorded in metafile; actual Native validation belongs to caller'],
    metafile: built.metafile };
  await writeFile(path.join(outputDir, 'variant-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  assert.deepEqual(await binding(hostInput), manifest.inputs[0]); assert.deepEqual(await binding(hookInput), manifest.inputs[1]);
  return { hostPath, hookPath, manifest };
}
