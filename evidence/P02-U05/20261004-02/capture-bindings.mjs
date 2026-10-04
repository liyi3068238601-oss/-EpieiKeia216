import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(evidenceDirectory, "../../..");
const outputPath = path.resolve(process.argv[2] ?? "");
if (path.dirname(outputPath) !== evidenceDirectory || existsSync(outputPath)) {
  throw new Error("output must be a new file in this evidence directory");
}

const require = createRequire(path.join(repositoryRoot, "package.json"));
const nativeLoads = [];
const originalDlopen = process.dlopen;
process.dlopen = function traceBetterSqliteAddon(module, filename, ...options) {
  const result = Reflect.apply(originalDlopen, this, [module, filename, ...options]);
  if (path.extname(filename).toLowerCase() === ".node") {
    const regularPath = filename.startsWith("\\\\?\\") ? filename.slice(4) : filename;
    const realPath = realpathSync(regularPath);
    const bytes = readFileSync(realPath);
    nativeLoads.push({
      loaderPath: filename,
      path: realPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return result;
};

const BetterSqlite3 = require("better-sqlite3");
const database = new BetterSqlite3(":memory:");
database.defaultSafeIntegers(true);
const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
database.close();
process.dlopen = originalDlopen;
if (nativeLoads.length !== 1) throw new Error(`expected one loaded better-sqlite3 addon, observed ${nativeLoads.length}`);

const betterEntry = require.resolve("better-sqlite3");
const betterRoot = findPackageRoot(betterEntry, "better-sqlite3");
const typeRoot = realpathSync(path.join(repositoryRoot, "node_modules", "@types", "better-sqlite3"));
const addonApiEntry = createRequire(path.join(betterRoot, "package.json")).resolve("node-addon-api");
const addonApiRoot = findPackageRoot(addonApiEntry, "node-addon-api");
const packageTrees = [
  treeRecord("better-sqlite3", betterRoot),
  treeRecord("@types/better-sqlite3", typeRoot),
  treeRecord("node-addon-api", addonApiRoot),
];

const metadataPaths = [
  path.join(repositoryRoot, "package.json"),
  path.join(repositoryRoot, "pnpm-lock.yaml"),
  path.join(repositoryRoot, "node_modules", ".modules.yaml"),
  path.join(repositoryRoot, "node_modules", ".pnpm", "lock.yaml"),
];
const installationMetadata = metadataPaths.map((filename) => {
  const bytes = readFileSync(filename);
  return { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
});

const result = {
  schema: "p02-u05-binding-inputs/v1",
  node: {
    executable: process.execPath,
    version: process.version,
    moduleAbi: process.versions.modules,
    napi: process.versions.napi,
    builtinSqlite: process.versions.sqlite,
  },
  betterSqlite: {
    packageVersion: require("better-sqlite3/package.json").version,
    resolvedEntry: betterEntry,
    sqliteVersion,
    nativeAddon: nativeLoads[0],
  },
  packageTrees,
  installationMetadata,
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  output: outputPath,
  betterSqliteVersion: result.betterSqlite.packageVersion,
  sqliteVersion,
  addon: nativeLoads[0],
  trees: packageTrees.map(({ name, files, bytes, sha256: digest }) => ({ name, files, bytes, sha256: digest })),
  metadata: installationMetadata,
}));

function findPackageRoot(entry, packageName) {
  let current = path.dirname(entry);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath) && JSON.parse(readFileSync(packagePath, "utf8")).name === packageName) {
      return realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`could not find package root for ${packageName}`);
    current = parent;
  }
}

function treeRecord(name, root) {
  const entries = [];
  let bytes = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const info = lstatSync(filename);
      if (info.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: readlinkSync(filename) });
      } else if (info.isDirectory()) {
        visit(filename);
      } else if (info.isFile()) {
        const contents = readFileSync(filename);
        bytes += contents.length;
        entries.push({ path: relative, type: "file", bytes: contents.length, sha256: sha256(contents) });
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    name,
    root,
    files: entries.filter((entry) => entry.type === "file").length,
    entries,
    bytes,
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
