// Reuse the accepted U08 Desktop recipe and the pinned native CLI build graph.
// The reference checkout is input only; all build output stays in a new candidate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDesktop, SOURCE_PIN } from "../../../packages/config/desktop-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const HOST_ROOT = "E:\\Xiadie\\Xiadie";
const DEFAULT_SOURCE = path.join(HOST_ROOT, ".runtime/P01/desktop-source");
const NODE = path.join(HOST_ROOT, ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe");
const digest = (data) => createHash("sha256").update(data).digest("hex");
const save = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");

function assertAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

async function binding(file) {
  const bytes = await readFile(file);
  return { path: file, bytes: bytes.length, sha256: digest(bytes) };
}

async function bindRepositoryInputs(commit) {
  const names = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", "packages", "assets", "plugins",
    "tests/integration/P01", "tests/integration/P02", "migrations", "tools", "package.json", "pnpm-lock.yaml", "tsconfig.json"], { encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
  const bindings = [];
  for (const relative of names) {
    const file = path.join(REPO, relative);
    const committed = execFileSync("git", ["-C", REPO, "show", `${commit}:${relative}`], { maxBuffer: 64 * 1024 * 1024 });
    const data = await readFile(file);
    assert.deepEqual(data, committed, `Repository input differs from committed bytes: ${relative}`);
    bindings.push({ path: relative, bytes: data.length, sha256: digest(data) });
  }
  return bindings;
}

async function bindTree(root) {
  const result = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (relative === "node_modules" && entry.isSymbolicLink()) {
        assert.equal(await realpath(file), await realpath(path.join(DEFAULT_SOURCE, "node_modules")),
          "Only the exact pinned Native dependency junction may be borrowed");
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Unexpected candidate resource link: ${relative}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result.push({ ...(await binding(file)), path: relative });
      else throw new Error(`Unexpected non-file candidate resource: ${relative}`);
    }
  }
  await visit(root);
  return result;
}

async function bindPackageTree(packageRoot, assemblyRoot) {
  const result = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected SQLite package link: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        result.push({ ...(await binding(file)), path: path.relative(assemblyRoot, file).replaceAll("\\", "/") });
      } else throw new Error(`Unexpected SQLite package resource: ${file}`);
    }
  }
  await visit(packageRoot);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function stageBetterSqlitePackage(sourceRoot, assemblyRoot) {
  const sourcePackageRoot = path.resolve(sourceRoot, "node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3");
  const packageJsonPath = path.join(sourcePackageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(packageJson.name, "better-sqlite3");
  assert.equal(packageJson.version, "13.0.3");
  assert.equal(packageJson.license, "MIT");
  assert.equal(process.platform, "win32", "The candidate runtime currently targets Windows");
  assert.equal(process.arch, "x64", "The candidate runtime currently targets Windows x64");

  const targetPackageRoot = path.join(assemblyRoot, "apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3");
  await mkdir(targetPackageRoot, { recursive: true });
  await cp(path.join(sourcePackageRoot, "package.json"), path.join(targetPackageRoot, "package.json"));
  await cp(path.join(sourcePackageRoot, "LICENSE"), path.join(targetPackageRoot, "LICENSE"));
  await cp(path.join(sourcePackageRoot, "lib"), path.join(targetPackageRoot, "lib"), { recursive: true });

  const addonName = "win32-x64.node";
  const addonSource = path.join(sourcePackageRoot, "prebuilds", addonName);
  const addonTarget = path.join(targetPackageRoot, "prebuilds", addonName);
  await mkdir(path.dirname(addonTarget), { recursive: true });
  await cp(addonSource, addonTarget);
  const addon = await binding(addonTarget);
  assert.equal(addon.sha256, "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a",
    "The candidate must carry the accepted U02/U05 Windows x64 prebuild");
  const closedFiles = await bindPackageTree(targetPackageRoot, assemblyRoot);
  const packagePrefix = path.relative(assemblyRoot, targetPackageRoot).replaceAll("\\", "/");
  const sourceLibFiles = await bindPackageTree(path.join(sourcePackageRoot, "lib"), path.join(sourcePackageRoot, "lib"));
  const candidateLibFiles = await bindPackageTree(path.join(targetPackageRoot, "lib"), path.join(targetPackageRoot, "lib"));
  assert.deepEqual(candidateLibFiles, sourceLibFiles, "The complete official Better SQLite lib tree must be staged unchanged");
  const expectedPackageFiles = [
    `${packagePrefix}/LICENSE`,
    ...candidateLibFiles.map(({ path: file }) => `${packagePrefix}/lib/${file}`),
    `${packagePrefix}/package.json`,
    `${packagePrefix}/prebuilds/win32-x64.node`,
  ].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(closedFiles.map(({ path: file }) => file), expectedPackageFiles,
    "The candidate owns exactly package metadata, license, complete lib tree and target prebuild");
  return {
    packageRoot: targetPackageRoot,
    packageVersion: packageJson.version,
    licensePath: path.join(targetPackageRoot, "LICENSE"),
    license: await readFile(path.join(targetPackageRoot, "LICENSE"), "utf8"),
    addon,
    closedFiles,
  };
}

export async function buildCandidate({ source = DEFAULT_SOURCE, destination }) {
  assertAbsolute(source, "source");
  assertAbsolute(destination, "destination");
  const repositoryCommit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim(), "",
    "Candidate build requires a clean, committed repository");
  const repositoryInputs = await bindRepositoryInputs(repositoryCommit);
  const physicalSource = await realpath(source);
  const factoryEntry = path.join(HERE, "factory-entry.mjs");
  await readFile(factoryEntry); // Fail before creating a candidate if its seam is absent.
  const nodeVersion = execFileSync(NODE, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(nodeVersion, "v24.14.0");
  const base = await buildDesktop(physicalSource, destination);
  const assemblyRoot = base.assemblyRoot;
  const resources = path.join(assemblyRoot, "xiadie");
  await mkdir(resources);
  for (const name of ["dist", "assets", "plugins"]) {
    await cp(path.join(REPO, name), path.join(resources, name), { recursive: true, errorOnExist: true });
  }
  const betterSqlite = await stageBetterSqlitePackage(REPO, assemblyRoot);

  const cliDirectory = path.join(physicalSource, "apps/zcode-cli/packages/cli");
  const cliRoot = path.join(physicalSource, "apps/zcode-cli");
  const nativePackages = path.join(cliRoot, "packages");
  const require = createRequire(path.join(physicalSource, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
  const nativeBuild = await import(pathToFileURL(path.join(cliDirectory, "scripts/build.mjs")).href);
  const cliVersion = await nativeBuild.readRootPackageVersion({ root: cliRoot });
  const expectedZod = await nativeBuild.readZodBuildVersion();
  const electronPath = path.join(physicalSource, "node_modules/electron/dist/electron.exe");
  const playwrightPath = require.resolve("playwright-core");
  const targetProtocol = path.join(nativePackages, "bootstrap/dist/zcode-protocol-entrypoint.js");
  const targetInvocation = await realpath(path.join(nativePackages, "contracts/dist/model/invocation-context.js"));
  const cliEntry = path.join(assemblyRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  const nativeAlias = (relative) => path.join(nativePackages, relative);
  const aliases = {
    ...nativeBuild.resolveBuildAliases({ cliDirectory, rootDirectory: cliRoot }),
    "@p01/profile": path.join(REPO, "packages/config/src/index.ts"),
    "@p01/secrets": path.join(REPO, "packages/secrets/src/index.ts"),
    "@p01/xiadie-host": path.join(REPO, "packages/adapters/zcode/src/index.ts"),
    "@p01/turn-projection": path.join(REPO, "packages/application/turn-projection.ts"),
    "@p01/native-execution": nativeAlias("adapters/dist/exec/index.js"),
    "@p01/native-filesystem": nativeAlias("adapters/dist/fs/index.js"),
    "@p01/native-filesystem-contracts": nativeAlias("contracts/dist/interfaces/file-system.port.js"),
    "@p01/native-model-factory": nativeAlias("bootstrap/dist/model-factory.js"),
    "@p01/native-model-config": nativeAlias("bootstrap/dist/model-config.js"),
    "@p01/native-plugin-api": nativeAlias("bootstrap/dist/plugins.js"),
    "@p01/native-app": nativeAlias("bootstrap/dist/app/create-app.js"),
    "@p01/native-invocation-context": targetInvocation,
  };
  const needle = 'import { createZCodeApp } from "./app/create-app.js";';
  let patches = 0;
  let patchBinding;
  const noticesFile = path.join(assemblyRoot, "apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md");
  const notices = await readFile(noticesFile, "utf8");
  const betterSqliteNotices = `${notices.trimEnd()}\n\n## better-sqlite3 ${betterSqlite.packageVersion}\n\n${betterSqlite.license.trim()}\n`;
  const addonObserver = `;(() => {
  const key = Symbol.for("xiadie.p02.better-sqlite3-loads");
  Object.defineProperty(globalThis, key, { configurable: false, enumerable: false, writable: false, value: [] });
  const original = process.dlopen;
  if (typeof original !== "function") throw new Error("P02_SQLITE_DLOPEN_UNAVAILABLE");
  const realpath = require("node:fs").realpathSync.native;
  process.dlopen = function p02ObserveDlopen(module, filename, ...flags) {
    const result = Reflect.apply(original, process, [module, filename, ...flags]);
    if (typeof filename === "string" && /[\\\\/]better-sqlite3[\\\\/]prebuilds[\\\\/]win32-x64\\.node$/i.test(filename)) {
      globalThis[key].push({ path: realpath(filename), pid: process.pid });
    }
    return result;
  };
})();`;
  const result = await build({
    absWorkingDir: physicalSource,
    entryPoints: [path.join(cliDirectory, "src/main.ts")],
    outfile: cliEntry,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: true,
    keepNames: true,
    sourcemap: false,
    metafile: true,
    legalComments: "none",
    logLevel: "info",
    external: [...nativeBuild.resolveBuildExternal(), "better-sqlite3"],
    alias: aliases,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
      __P01_REPOSITORY_ROOT__: JSON.stringify(resources),
      __P01_NODE_EXECUTABLE__: JSON.stringify(NODE),
      __P01_ELECTRON_EXECUTABLE__: JSON.stringify(electronPath),
    },
    banner: { js: `#!/usr/bin/env node\n"use strict";\n${addonObserver}\nif (process.argv.length === 3 && process.argv[2] === "--licenses") { const sea = require("node:sea"); const nodeNotice = sea.isSea() ? "\\n\\n## Bundled Node.js runtime\\n\\n" + sea.getAsset("zcode-node-license", "utf8") : ""; process.stdout.write(${JSON.stringify(betterSqliteNotices)} + nodeNotice, () => process.exit(0)); } else {` },
    footer: { js: "}" },
    plugins: [
      { name: "xiadie-p02-protocol-factory", setup(builder) {
        builder.onResolve({ filter: /^p02:factory$/ }, () => ({ path: factoryEntry }));
        builder.onLoad({ filter: /zcode-protocol-entrypoint\.js$/ }, async (args) => {
          assert.equal(path.resolve(args.path), targetProtocol);
          const original = await readFile(args.path, "utf8");
          assert.equal(original.split(needle).length, 2, "Pinned protocol factory import changed");
          const contents = original.replace(needle, 'import { createZCodeApp } from "p02:factory";');
          patches += 1;
          patchBinding = { file: targetProtocol, originalSha256: digest(original), patchedSha256: digest(contents) };
          return { contents, loader: "js", resolveDir: path.dirname(args.path) };
        });
      } },
      nativeBuild.createZodDedupePlugin({ expectedV4Version: expectedZod }),
    ],
  });
  const sqliteRuntime = createRequire(cliEntry)("better-sqlite3");
  const sqliteVersionDatabase = new sqliteRuntime(":memory:");
  let sqliteVersion;
  try {
    sqliteVersion = sqliteVersionDatabase.prepare("SELECT sqlite_version() AS version").get().version;
  } finally {
    sqliteVersionDatabase.close();
  }
  assert.equal(sqliteVersion, "3.53.4", "The owned addon must report the accepted SQLite runtime version");
  assert.equal(patches, 1, "CLI must contain exactly one protocol factory overlay");
  const invocationInputs = Object.keys(result.metafile.inputs).filter((file) => /[/\\]model[/\\]invocation-context\.[cm]?[jt]s$/.test(file));
  assert.equal(invocationInputs.length, 1, "Native invocation AsyncLocalStorage must have one module instance");
  assert.equal(await realpath(path.resolve(physicalSource, invocationInputs[0])), targetInvocation);
  const providerSource = path.join(physicalSource, "config/provider/zcode-builtin.json");
  const providerBlob = execFileSync("git", ["-C", physicalSource, "show", `${SOURCE_PIN}:config/provider/zcode-builtin.json`]);
  assert.deepEqual(await readFile(providerSource), providerBlob, "Provider config must match the pinned tracked input");
  const providerStagingFile = path.join(physicalSource, "scripts/builtin-provider-config.mjs");
  const { stageBuiltinProviderConfig } = await import(pathToFileURL(providerStagingFile).href);
  const provider = await stageBuiltinProviderConfig({
    root: physicalSource,
    directory: path.join(path.dirname(cliEntry), "provider"),
    env: { NODE_ENV: "production", ZCODE_ENV: "production", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: providerSource },
  });
  assert.equal(provider.sourcePath, providerSource);
  assert.equal(digest(Buffer.from(provider.content)), digest(providerBlob));
  const inputBindings = [];
  for (const file of Object.keys(result.metafile.inputs).sort()) inputBindings.push(await binding(path.resolve(physicalSource, file)));
  const manifestDir = path.join(assemblyRoot, "build-evidence");
  await mkdir(manifestDir);
  await save(path.join(manifestDir, "cli-inputs.json"), inputBindings);
  await save(path.join(manifestDir, "cli-metafile.json"), result.metafile);
  assert.equal(execFileSync("git", ["-C", physicalSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), SOURCE_PIN);
  assert.equal(execFileSync("git", ["-C", physicalSource, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  assert.equal(execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), repositoryCommit);
  assert.equal(execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  assert.deepEqual(await bindRepositoryInputs(repositoryCommit), repositoryInputs,
    "Repository inputs changed while building the candidate");
  const artifacts = await bindTree(assemblyRoot);
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  for (const file of betterSqlite.closedFiles) assert.deepEqual(artifactByPath.get(file.path), file,
    `Owned SQLite package file must be present in the full artifact closure: ${file.path}`);
  const betterSqlitePackagePrefix = path.relative(assemblyRoot, betterSqlite.packageRoot).replaceAll("\\", "/");
  assert.equal(artifacts.filter(({ path: file }) => file.startsWith(`${betterSqlitePackagePrefix}/`)).length,
    betterSqlite.closedFiles.length, "The entire owned SQLite runtime package must be bound exactly once");
  const descriptor = {
    schemaVersion: 1,
    sourceCommit: SOURCE_PIN,
    sourceRoot: physicalSource,
    repositoryCommit,
    repositoryInputs,
    assemblyRoot,
    desktopPath: base.destination,
    cliEntry,
    cwd: assemblyRoot,
    electronPath,
    playwrightPath,
    nodePath: NODE,
    factoryEntry,
    factory: await binding(factoryEntry),
    recipe: await binding(fileURLToPath(import.meta.url)),
    cli: await binding(cliEntry),
    resourcesRoot: resources,
    gateEnv: "P01_U10_GATE_MODE",
    gateDefault: "enabled",
    candidateModel: "deepseek-flash",
    deniedModel: "deepseek-v4-pro",
    protocolPatch: patchBinding,
    providerConfig: { source: await binding(providerSource), recipe: await binding(providerStagingFile), environment: provider.environment },
    invocationContext: await binding(targetInvocation),
    invocationContextModuleCount: invocationInputs.length,
    sqliteRuntime: {
      packageRoot: betterSqlitePackagePrefix,
      packageVersion: betterSqlite.packageVersion,
      sqliteVersion,
      addonPath: path.relative(assemblyRoot, betterSqlite.addon.path).replaceAll("\\", "/"),
      addonSha256: betterSqlite.addon.sha256,
      licensePath: path.relative(assemblyRoot, betterSqlite.licensePath).replaceAll("\\", "/"),
      licenseSha256: (await binding(betterSqlite.licensePath)).sha256,
      closedFiles: betterSqlite.closedFiles,
    },
    nodeVersion,
    artifacts,
    scope: "Local development candidate with one borrowed pinned Native dependency junction and an owned better-sqlite3 runtime package. The final descriptor binds every candidate file except itself and the exact borrowed root junction; not a portable installer.",
  };
  await save(path.join(assemblyRoot, "candidate-descriptor.json"), descriptor);
  return descriptor;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") throw new Error("usage: node tests/integration/P02/build-candidate.mjs --output <new absolute directory>");
  const candidate = await buildCandidate({ destination: args[1] });
  console.log(JSON.stringify({ candidate: await binding(path.join(candidate.assemblyRoot, "candidate-descriptor.json")), artifacts: candidate.artifacts.length, cliSha256: candidate.cli.sha256 }));
}
