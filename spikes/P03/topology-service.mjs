// P03-U02 owned fixtures. The pinned Native service is bundled without source changes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = 'E:\\Xiadie\\Xiadie';
const SOURCE = path.join(ROOT, '.runtime/P01/desktop-source');
const PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e';
const SELF = fileURLToPath(import.meta.url);
const hash = b => createHash('sha256').update(b).digest('hex');
const save = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
async function binding(p) { const b = await readFile(p); return { path: p, bytes: b.length, sha256: hash(b) }; }
const argv = process.argv.slice(2);
const output = path.resolve(argv[1] ?? '');
const allowed = path.join(ROOT, '.runtime/P03/experiments');
assert.ok(path.isAbsolute(argv[1] ?? '') && output.startsWith(allowed + path.sep), 'explicit owned output root required');
assert.ok(['--output', '--service-worker'].includes(argv[0]), 'expected --output or --service-worker');
const profile = path.join(output, 'profile');
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]));
Object.assign(env, { HOME: path.join(profile, 'home'), USERPROFILE: path.join(profile, 'home'),
  TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp'),
  ZCODE_DATA_BASE_DIR: profile, ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(output, 'empty.gitconfig') });

if (argv[0] === '--service-worker') await serviceWorker();
else await main();

async function main() {
  await mkdir(output); // A previous or failed run is never overwritten.
  const commands = [];
  const run = (exe, args, cwd = output) => {
    const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const record = { argv: [exe, ...args], cwd, exit_code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    commands.push(record);
    assert.equal(r.status, 0, JSON.stringify(record));
    return r.stdout.trim();
  };
  try {
    await Promise.all([mkdir(env.HOME, { recursive: true }), mkdir(env.TEMP, { recursive: true }),
      mkdir(path.join(output, 'empty-template')), writeFile(env.GIT_CONFIG_GLOBAL, '')]);
    assert.equal(run('git', ['rev-parse', 'HEAD'], SOURCE), PIN);
    assert.equal(run('git', ['status', '--porcelain'], SOURCE), '');
    const requireSource = createRequire(path.join(SOURCE, 'package.json'));
    const esbuild = requireSource('esbuild');
    const entry = path.join(output, 'native-entry.ts');
    await writeFile(entry, [
      `export { createMemoryService } from ${JSON.stringify(path.join(SOURCE, 'packages/services/src/memory/memoryService.ts'))};`,
      `export { resolveProjectMemoryRoot } from ${JSON.stringify(path.join(SOURCE, 'apps/zcode-cli/packages/core/src/memory/project-root.ts'))};`,
      `export { formatProjectMemoryIndexContent } from ${JSON.stringify(path.join(SOURCE, 'apps/zcode-cli/packages/core/src/memory/index-content.ts'))};`,
    ].join('\n'));
    const built = await esbuild.build({ entryPoints: [entry], outfile: path.join(output, 'native-memory.mjs'),
      absWorkingDir: SOURCE, bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent' });
    await save(path.join(output, 'esbuild-metafile.json'), built.metafile);
    const compileInputs = [];
    for (const name of Object.keys(built.metafile.inputs)) compileInputs.push(await binding(path.resolve(SOURCE, name)));
    const native = await import(pathToFileURL(path.join(output, 'native-memory.mjs')).href);
    const git = (dir, ...args) => run('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + path.join(output, 'empty-template'),
      '-c', 'user.name=P03 synthetic fixture', '-c', 'user.email=p03-fixture@example.invalid', ...args], dir);
    const a = path.join(output, 'A/repo'); const b = path.join(output, 'B/repo');
    for (const repo of [a, b]) {
      await mkdir(repo, { recursive: true });
      git(repo, '-c', 'init.templateDir=' + path.join(output, 'empty-template'), 'init', '-b', 'main');
      await writeFile(path.join(repo, 'schema.mjs'), 'export const schema = "current-v2";\n');
      git(repo, 'add', 'schema.mjs'); git(repo, 'commit', '-m', 'owned current schema fixture');
    }
    const wt1 = path.join(output, 'A/worktree-one'); const wt2 = path.join(output, 'A/worktree-two');
    git(a, 'worktree', 'add', '-b', 'fixture-one', wt1); git(a, 'worktree', 'add', '-b', 'fixture-two', wt2);
    const identity = dir => ({ workspace: dir, commonDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      privateDir: git(dir, 'rev-parse', '--absolute-git-dir'), top: git(dir, 'rev-parse', '--show-toplevel'), commit: git(dir, 'rev-parse', 'HEAD') });
    const before = [a, wt1, wt2, b].map(identity);
    assert.equal(before[0].commonDir, before[1].commonDir); assert.equal(before[0].commonDir, before[2].commonDir);
    assert.notEqual(before[0].commonDir, before[3].commonDir); assert.notEqual(before[0].privateDir, before[1].privateDir);
    const moved = path.join(output, 'A/worktree-moved');
    assert.ok(path.resolve(wt1).startsWith(output + path.sep) && path.resolve(moved).startsWith(output + path.sep));
    const fileBefore = await binding(path.join(wt1, 'schema.mjs'));
    git(a, 'worktree', 'move', wt1, moved);
    const after = identity(moved);
    assert.equal(after.commonDir, before[0].commonDir); assert.equal((await binding(path.join(moved, 'schema.mjs'))).sha256, fileBefore.sha256);
    const copy = path.join(output, 'copy/repo');
    await cp(a, copy, { recursive: true, errorOnExist: true, force: false });
    const copied = identity(copy);
    assert.notEqual(copied.commonDir, before[0].commonDir);

    // Cross-volume relocation is copy + verify + explicit Git repair. The old copy is retained as an archive.
    const crossRoot = await mkdtemp(path.join(os.tmpdir(), 'xiadie-p03-u02-owned-'));
    assert.ok(path.resolve(crossRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.notEqual(path.parse(crossRoot).root.toLowerCase(), path.parse(output).root.toLowerCase());
    const cross = path.join(crossRoot, 'worktree-two');
    await cp(wt2, cross, { recursive: true, errorOnExist: true, force: false });
    const crossSource = await treeHashes(wt2); const crossTarget = await treeHashes(cross);
    assert.deepEqual(crossTarget, crossSource);
    git(a, 'worktree', 'repair', cross);
    const crossIdentity = identity(cross);
    assert.equal(crossIdentity.commonDir, before[0].commonDir); assert.equal(crossIdentity.commit, before[2].commit);
    const listings = git(a, 'worktree', 'list', '--porcelain');
    assert.ok(listings.replaceAll('\\', '/').includes(cross.replaceAll('\\', '/')));
    const cliStorageRoot = path.join(profile, '.zcode/cli');
    const idA = randomUUID(); const idB = randomUUID();
    const nativeRoot = (workspacePath, workspaceIdentity) => native.resolveProjectMemoryRoot({ cliStorageRoot, workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}) });
    const roots = { legacyA: nativeRoot(a), legacyB: nativeRoot(b), oldWorktree: nativeRoot(wt1), movedWorktree: nativeRoot(moved),
      stableA: nativeRoot(a, idA), stableMoved: nativeRoot(moved, idA), stableCross: nativeRoot(cross, idA), stableB: nativeRoot(b, idB) };
    assert.notEqual(roots.legacyA, roots.legacyB); assert.notEqual(roots.oldWorktree, roots.movedWorktree);
    assert.equal(roots.stableA, roots.stableMoved); assert.equal(roots.stableA, roots.stableCross);
    assert.notEqual(roots.stableA, roots.stableB); assert.notEqual(roots.legacyA, roots.stableA);
    for (const [name, dir] of [['A', roots.legacyA], ['B', roots.legacyB]]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'MEMORY.md'), '[schema](schema.md)\n');
      await writeFile(path.join(dir, 'schema.md'), `---\nrecorded_at: 2023-10-08\n---\n${name}_OWNED_MEMORY schema=obsolete-v1\n`);
    }
    const memoryBefore = await treeHashes(path.join(profile, '.zcode/cli/memories'));
    const fixtures = { roots, idA, idB, projectA: a, projectB: b, nativePin: PIN };
    await save(path.join(output, 'fixtures.json'), fixtures);
    const workerResult = run(process.execPath, [SELF, '--service-worker', output]);
    assert.ok(workerResult.includes('P03_SERVICE_PASS'));
    const memoryAfter = await treeHashes(path.join(profile, '.zcode/cli/memories'));
    assert.deepEqual(memoryAfter, memoryBefore, 'all failure fixtures restored; service never clears memory');
    assert.equal(run('git', ['status', '--porcelain'], SOURCE), '');
    await save(path.join(output, 'summary.json'), { status: 'pass', scope: 'U02 topology and actual pinned MemoryService only',
      evidenceLevel: 'real Git and native file service; synthetic owned data; no model/desktop calls',
      runtime: { node: process.version, execPath: process.execPath, esbuild: esbuild.version, nativePin: PIN },
      script: await binding(SELF), bundle: await binding(path.join(output, 'native-memory.mjs')), compileInputs,
      before, moved: after, copied, crossVolume: { crossRoot, sourceRetainedAsArchive: wt2, active: crossIdentity,
        sourceVolume: path.parse(wt2).root, targetVolume: path.parse(cross).root, copiedFileHashes: crossSource },
      roots, mappingProposal: { project_id: idA, canonical_native_key: path.basename(path.dirname(roots.legacyA)),
        proposed_uuid_key: path.basename(path.dirname(roots.stableA)), noKnowledgeCopied: true,
        reason: 'Native identity is a key projection, not a persisted registry; legacy canonical root needs explicit adoption.' },
      memoryBefore, memoryAfter, oldNoteDate: '2023-10-08', sampledAt: new Date().toISOString(),
      currentSchema: await binding(path.join(a, 'schema.mjs')), unchangedByTime: true,
      model: 'NOT_RUN', desktop: 'NOT_RUN', productRegistry: 'NOT_IMPLEMENTED', sourceUnchanged: true });
    process.stdout.write(JSON.stringify({ status: 'pass', output, sourcePin: PIN, crossVolume: cross, sourceInputs: compileInputs.length }) + '\n');
  } finally { await save(path.join(output, 'commands.json'), commands); }
}

async function treeHashes(dir) {
  const files = [];
  async function visit(at) {
    for (const e of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(at, e.name); assert.ok(!e.isSymbolicLink());
      if (e.isDirectory()) await visit(p); else { const b = await binding(p); files.push({ ...b, path: path.relative(dir, p) }); }
    }
  }
  await visit(dir); return files;
}

async function serviceWorker() {
  assert.equal(process.env.ZCODE_DATA_BASE_DIR, profile, 'profile must be set before native module import');
  const native = await import(pathToFileURL(path.join(output, 'native-memory.mjs')).href);
  const service = native.createMemoryService();
  const { roots } = JSON.parse(await readFile(path.join(output, 'fixtures.json')));
  const keyA = path.basename(path.dirname(roots.legacyA)); const keyB = path.basename(path.dirname(roots.legacyB));
  const read = (workspaceId, fileName) => service.readProjectMemoryFile({ workspaceId, fileName });
  const cases = [];
  const record = (name, details) => cases.push({ name, status: 'pass', ...details });
  const denied = async (name, action, expected) => {
    let caught;
    try { await action(); } catch (e) { caught = e; }
    assert.ok(caught, `${name} unexpectedly succeeded`);
    if (expected) assert.match(String(caught.code ?? caught.message), expected);
    record(name, { code: caught.code ?? null, message: caught.message });
  };
  const a = await read(keyA, 'schema.md'); const b = await read(keyB, 'schema.md');
  assert.ok(a.content.includes('A_OWNED_MEMORY') && !a.content.includes('B_OWNED_MEMORY'));
  assert.ok(b.content.includes('B_OWNED_MEMORY') && !b.content.includes('A_OWNED_MEMORY'));
  assert.deepEqual(Object.keys(a).sort(), ['content', 'updatedAt']);
  record('two projects selected explicitly and raw frontmatter retained', { a, b, responseKeys: Object.keys(a), rawByteHashProvided: false });
  const catalog = await service.listProjectMemories(); assert.equal(catalog.length, 2);
  record('actual service catalog', { keys: catalog.map(x => x.id) });
  await denied('missing file', () => read(keyA, 'missing.md'), /ENOENT/);
  await denied('relative escape', () => read(keyA, '../schema.md'), /Invalid Project Memory path/);
  await denied('absolute escape', () => read(keyA, path.join(roots.legacyB, 'schema.md')), /Invalid Project Memory path/);
  await denied('case alias', () => read(keyA, 'SCHEMA.md'), /does not match exactly/);
  const target = path.join(roots.legacyA, 'schema.md'); const original = await readFile(target);
  try {
    const invalid = Buffer.from([0x41, 0xc3, 0x28, 0x42]); await writeFile(target, invalid);
    const result = await read(keyA, 'schema.md');
    assert.ok(result.content.includes('\uFFFD'));
    assert.notEqual(hash(Buffer.from(result.content)), hash(invalid));
    record('invalid UTF-8 is replacement-decoded: required-contract gap', { sourceHash: hash(invalid), textHash: hash(Buffer.from(result.content)), result });
    const badFrontmatter = '---\ninvalid: [\nA_STILL_UNPARSED\n'; await writeFile(target, badFrontmatter);
    assert.equal((await read(keyA, 'schema.md')).content, badFrontmatter);
    record('broken frontmatter is not validated by service', { kind: 'text returned; product must validate separately' });
    await writeFile(target, Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    await denied('native five MiB read limit', () => read(keyA, 'schema.md'), /PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED/);
    await writeFile(target, original);
    const sidText = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = sidText.match(/S-1-5-[\d-]+/)?.[0]; assert.ok(sid);
    const aclCommands = [];
    const acl = args => { const r = spawnSync('icacls.exe', args, { windowsHide: true });
      const stdout = r.stdout ?? Buffer.alloc(0); const stderr = r.stderr ?? Buffer.alloc(0);
      aclCommands.push({ argv: ['icacls.exe', ...args], cwd: process.cwd(), exit_code: r.status,
        stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'),
        stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
        stdout: new TextDecoder('gb18030').decode(stdout), stderr: new TextDecoder('gb18030').decode(stderr) });
      assert.equal(r.status, 0, stderr.toString()); };
    try { acl([target, '/deny', '*' + sid + ':(R)']); await denied('actual owned-file ACL denies read', () => read(keyA, 'schema.md'), /EACCES|EPERM/); }
    finally { acl([target, '/remove:d', '*' + sid]); await save(path.join(output, 'acl-commands.json'), aclCommands); }
    assert.equal((await read(keyA, 'schema.md')).content, original.toString('utf8'));
    record('recovery after ACL restoration', { sourceHash: hash(original) });
    await writeFile(target, 'A_REFRESHED_BYTES\n');
    assert.equal((await read(keyA, 'schema.md')).content, 'A_REFRESHED_BYTES\n');
    record('service sees changed file on next call', {});
  } finally { await writeFile(target, original); }
  const projectRoot = path.dirname(path.dirname(roots.legacyA));
  const link = path.join(projectRoot, 'owned-junction-0123456789abcdef');
  await symlink(path.dirname(roots.legacyB), link, 'junction');
  await denied('junction workspace refused', () => read(path.basename(link), 'schema.md'), /not a regular directory/);
  // Removing our newly created link only is safe; its target is untouched.
  const { unlink } = await import('node:fs/promises'); await unlink(link);
  const oversizedIndex = Array.from({ length: 201 }, (_, i) => `line ${i}`).join('\n');
  const formatted = native.formatProjectMemoryIndexContent(oversizedIndex);
  assert.ok(formatted.includes('WARNING: MEMORY.md') && !formatted.includes('line 200'));
  record('native index truncation is explicit', { inputLines: 201, warning: true });
  await save(path.join(output, 'service-results.json'), { status: 'pass', cases, sourcePin: PIN,
    process: { pid: process.pid, node: process.version, executable: process.execPath, profile },
    actualImplementation: 'Bundled unmodified pinned createMemoryService; no mock filesystem',
    conclusion: 'Use its stable-read/path design, but a strict raw-byte/hash and parse-state adapter is needed for U04.' });
  process.stdout.write('P03_SERVICE_PASS\n');
}
