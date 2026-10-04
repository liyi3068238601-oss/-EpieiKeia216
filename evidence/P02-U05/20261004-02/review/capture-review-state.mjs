import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = 'E:\\Xiadie\\Xiadie';
const author = path.join(root, '.runtime', 'P02', 'worktrees', 'mature-sqlite-store');
const review = path.join(root, '.runtime', 'P02', 'reviews', 'mature-sqlite-store-u05');
const phase = process.argv[2];
const startedAt = new Date().toISOString();
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fileInfo(filename) {
  try {
    const bytes = fs.readFileSync(filename);
    return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
  } catch (error) {
    return { path: filename, missing: error.code || String(error) };
  }
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { argv: ['git', ...args], exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function packageRootFrom(entry, expectedName) {
  let current = path.dirname(fs.realpathSync(entry));
  while (true) {
    const manifestPath = path.join(current, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === expectedName) return fs.realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('package root not found for ' + expectedName);
    current = parent;
  }
}
function treeInfo(dirname) {
  const rootPath = fs.realpathSync(dirname);
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop();
    const full = path.join(rootPath, rel);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childFull = path.join(rootPath, childRel);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(childFull);
        entries.push({ path: childRel.replaceAll(path.sep, '/'), type: 'symlink', target });
      } else if (entry.isDirectory()) {
        pending.push(childRel);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(childFull);
        entries.push({ path: childRel.replaceAll(path.sep, '/'), type: 'file', bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const aggregate = entries.map((e) => [e.path, e.type, e.bytes ?? '', e.sha256 ?? '', e.target ?? ''].join('\0')).join('\n');
  return { root: rootPath, files: entries.filter((e) => e.type === 'file').length, bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0), sha256: hash(Buffer.from(aggregate)), entries };
}
if (!['before', 'postbuild', 'after'].includes(phase)) throw new Error('phase must be before, postbuild, or after');

const authorRequire = createRequire(path.join(author, 'package.json'));
const betterEntry = fs.realpathSync(authorRequire.resolve('better-sqlite3'));
const betterRoot = packageRootFrom(betterEntry, 'better-sqlite3');
const betterRequire = createRequire(betterEntry);
const napiEntry = betterRequire.resolve('node-addon-api');
const napiRoot = packageRootFrom(napiEntry, 'node-addon-api');
const pnpmRoot = path.join(author, 'node_modules', '.pnpm');
const typeStoreName = fs.readdirSync(pnpmRoot).find((name) => name.startsWith('@types+better-sqlite3@'));
if (!typeStoreName) throw new Error('@types/better-sqlite3 store entry missing');
const typesRoot = fs.realpathSync(path.join(pnpmRoot, typeStoreName, 'node_modules', '@types', 'better-sqlite3'));

const Module = authorRequire('node:module');
const nativeLoads = [];
const originalNodeLoader = Module._extensions['.node'];
Module._extensions['.node'] = function captureNativeLoad(module, filename) {
  nativeLoads.push(fs.realpathSync(filename));
  return originalNodeLoader(module, filename);
};
let nativeProbe;
try {
  const Database = authorRequire(betterEntry);
  const db = new Database(':memory:');
  nativeProbe = {
    packageVersion: JSON.parse(fs.readFileSync(path.join(betterRoot, 'package.json'), 'utf8')).version,
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version,
  };
  db.close();
} finally {
  Module._extensions['.node'] = originalNodeLoader;
}
const loadedAddons = [...new Set(nativeLoads)].map(fileInfo);

const sourcePaths = [
  'AGENTS.md',
  'planning/Xiadie_V2_v1.1/tasks/P02-U05.md',
  'docs/sources.lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tools/run-tests.mjs',
  'migrations/001-event-store.ts',
  'packages/storage/events/src/index.ts',
  'packages/storage/events/src/sqlite.ts',
  'packages/storage/events/test/events.test.mjs',
  'packages/storage/events/test/sqlite-worker.mjs',
  'packages/application/recovery/src/index.ts',
  'packages/application/recovery/test/recovery.test.mjs',
  'evidence/P02-U05/20261004-02/manifest.json',
  'evidence/P02-U05/20261004-02/result.md',
  'evidence/P02-U05/20261004-02/dependencies-fixed-pre.json',
  'evidence/P02-U05/20261004-02/dependencies-fixed-post.json',
  'evidence/P02-U05/20261004-02/inputs-fixed-pre.json',
  'evidence/P02-U05/20261004-02/inputs-fixed-post.json',
];
const baselinePaths = [
  'AGENTS.md',
  'planning/Xiadie_V2_v1.1/tasks/P02-U05.md',
  'docs/sources.lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'migrations/001-event-store.ts',
  'packages/storage/events/src/index.ts',
  'packages/storage/events/test/events.test.mjs',
  'packages/application/recovery/src/index.ts',
  'packages/application/recovery/test/recovery.test.mjs',
  'packages/storage/backup/src/index.ts',
  'packages/storage/backup/test/backup.test.mjs',
  '.runtime/P02/coord/verify-author.py',
  '.runtime/P02/coord/verify-review.py',
  'evidence/P02-U02/20261004-02/review-final.json',
];
const metadataPaths = [
  path.join(author, 'node_modules', '.modules.yaml'),
  path.join(author, 'node_modules', '.pnpm', 'lock.yaml'),
  path.join(author, 'package.json'),
  path.join(author, 'pnpm-lock.yaml'),
];
const nodeExe = path.join(root, '.runtime', 'P01', 'desktop-build-evidence', 'toolchain', 'node-v24.14.0-win-x64', 'node.exe');
const result = {
  schema: 'p02-u05-review-state/v1',
  phase,
  command: { argv: [nodeExe, path.join(review, 'capture-review-state.mjs'), phase], cwd: author, startedAt },
  runtime: {
    executable: process.execPath,
    processVersions: {
      node: process.versions.node,
      modules: process.versions.modules,
      napi: process.versions.napi,
      sqlite: process.versions.sqlite,
    },
    executableFile: fileInfo(nodeExe),
    betterEntry,
    betterRoot,
    nativeProbe,
    loadedAddons,
  },
  packageTrees: {
    betterSqlite3: treeInfo(betterRoot),
    betterSqlite3Types: treeInfo(typesRoot),
    nodeAddonApi: treeInfo(napiRoot),
  },
  installMetadata: metadataPaths.map(fileInfo),
  authorGit: {
    head: git(author, ['rev-parse', 'HEAD']),
    status: git(author, ['status', '--porcelain=v1', '--untracked-files=all']),
  },
  baselineGit: {
    head: git(root, ['rev-parse', 'HEAD']),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
  },
  authorInputs: sourcePaths.map((rel) => fileInfo(path.join(author, rel))),
  baselineInputs: baselinePaths.map((rel) => fileInfo(path.join(root, rel))),
  compiledTree: fs.existsSync(path.join(author, 'dist')) ? treeInfo(path.join(author, 'dist')) : null,
  completedAt: new Date().toISOString(),
};
const output = path.join(review, 'state-' + phase + '.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ phase, authorHead: result.authorGit.head.stdout, rootHead: result.baselineGit.head.stdout, addon: loadedAddons, output, compiledTree: result.compiledTree && { files: result.compiledTree.files, bytes: result.compiledTree.bytes, sha256: result.compiledTree.sha256 } }, null, 2));
