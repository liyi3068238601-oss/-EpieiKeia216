import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";

const authorRoot = path.resolve(process.argv[2]);
const baselineRoot = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
const reviewRoot = path.dirname(outputPath);
if (path.dirname(outputPath) !== reviewRoot || existsSync(outputPath)) throw new Error("output must be new in review root");
const require = createRequire(path.join(authorRoot, "package.json"));
const nativeLoads = [];
const originalDlopen = process.dlopen;
process.dlopen = function traceAddon(module, filename, ...options) {
  const result = Reflect.apply(originalDlopen, this, [module, filename, ...options]);
  if (path.extname(filename).toLowerCase() === ".node") {
    const regularPath = filename.startsWith("\\\\?\\") ? filename.slice(4) : filename;
    const actualPath = realpathSync(regularPath);
    const bytes = readFileSync(actualPath);
    nativeLoads.push({ path: actualPath, bytes: bytes.length, sha256: sha(bytes) });
  }
  return result;
};
const BetterSQLite3 = require("better-sqlite3");
const connection = new BetterSQLite3(":memory:");
connection.defaultSafeIntegers(true);
const sqliteVersion = connection.prepare("SELECT sqlite_version() AS version").get().version;
connection.close();
process.dlopen = originalDlopen;
if (nativeLoads.length !== 1) throw new Error("expected exactly one native addon load");

const betterRoot = packageRoot(require.resolve("better-sqlite3"), "better-sqlite3");
const typesRoot = realpathSync(path.join(authorRoot, "node_modules", "@types", "better-sqlite3"));
const addonApiEntry = createRequire(path.join(betterRoot, "package.json")).resolve("node-addon-api");
const addonApiRoot = packageRoot(addonApiEntry, "node-addon-api");
const packageTrees = [treeRecord("better-sqlite3", betterRoot), treeRecord("@types/better-sqlite3", typesRoot), treeRecord("node-addon-api", addonApiRoot)];
const inputFiles = [
  "AGENTS.md", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tools/run-tests.mjs",
  "packages/storage/backup/src/index.ts", "packages/storage/backup/test/backup.test.mjs",
  "packages/storage/backup/test/backup-worker.mjs", "packages/storage/events/src/sqlite.ts",
  "packages/storage/events/src/index.ts", "migrations/001-event-store.ts",
];
const metadataFiles = ["package.json", "pnpm-lock.yaml", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"];
const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + result.stderr);
  return result.stdout.trim();
};
const result = {
  schema: "p02-u08-review-state/v1",
  capturedAt: new Date().toISOString(),
  author: {
    root: authorRoot,
    head: git(authorRoot, ["rev-parse", "HEAD"]),
    statusPorcelain: git(authorRoot, ["status", "--porcelain"]),
    inputs: Object.fromEntries(inputFiles.map((name) => [name, fileRecord(path.join(authorRoot, name))])),
    dist: treeRecord("dist", path.join(authorRoot, "dist")),
    packageTrees,
    installMetadata: metadataFiles.map((name) => ({ path: name, ...fileRecord(path.join(authorRoot, name)) })),
  },
  baseline: {
    root: baselineRoot,
    head: git(baselineRoot, ["rev-parse", "HEAD"]),
    statusPorcelain: git(baselineRoot, ["status", "--porcelain"]),
    node: { path: process.execPath, version: process.version, moduleAbi: process.versions.modules, napi: process.versions.napi,
      builtinSqlite: process.versions.sqlite, bytes: readFileSync(process.execPath).length, sha256: sha(readFileSync(process.execPath)) },
  },
  binding: { packageVersion: require("better-sqlite3/package.json").version, resolvedEntry: require.resolve("better-sqlite3"),
    sqliteVersion, addon: nativeLoads[0] },
};
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output: outputPath, authorHead: result.author.head, authorClean: !result.author.statusPorcelain,
  baselineHead: result.baseline.head, baselineClean: !result.baseline.statusPorcelain, node: result.baseline.node,
  binding: result.binding, trees: packageTrees.map(({ name, files, bytes, sha256 }) => ({ name, files, bytes, sha256 })),
  dist: { files: result.author.dist.files, bytes: result.author.dist.bytes, sha256: result.author.dist.sha256 } }));

function packageRoot(entry, expectedName) {
  let current = path.dirname(entry);
  while (true) {
    const filename = path.join(current, "package.json");
    if (existsSync(filename) && JSON.parse(readFileSync(filename, "utf8")).name === expectedName) return realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error("could not resolve package root for " + expectedName);
    current = parent;
  }
}

function fileRecord(filename) {
  const bytes = readFileSync(filename);
  return { bytes: bytes.length, sha256: sha(bytes) };
}

function treeRecord(name, root) {
  const entries = [];
  let bytes = 0;
  if (!existsSync(root)) return { name, root, files: 0, bytes, entries, sha256: sha(Buffer.from("missing")) };
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const info = lstatSync(filename);
      if (info.isSymbolicLink()) entries.push({ path: relative, type: "symlink", target: readlinkSync(filename) });
      else if (info.isDirectory()) visit(filename);
      else if (info.isFile()) {
        const contents = readFileSync(filename);
        bytes += contents.length;
        entries.push({ path: relative, type: "file", bytes: contents.length, sha256: sha(contents) });
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { name, root, files: entries.filter((entry) => entry.type === "file").length, bytes, entries,
    sha256: sha(Buffer.from(JSON.stringify(entries))) };
}

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
