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

async function bindTree(root) {
  const result = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) throw new Error("Unexpected candidate resource link");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result.push({ ...(await binding(file)), path: path.relative(root, file).replaceAll("\\", "/") });
    }
  }
  await visit(root);
  return result;
}

export async function buildCandidate({ source = DEFAULT_SOURCE, destination }) {
  assertAbsolute(source, "source");
  assertAbsolute(destination, "destination");
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
    external: nativeBuild.resolveBuildExternal(),
    alias: aliases,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
      __P01_REPOSITORY_ROOT__: JSON.stringify(resources),
      __P01_NODE_EXECUTABLE__: JSON.stringify(NODE),
      __P01_ELECTRON_EXECUTABLE__: JSON.stringify(electronPath),
    },
    banner: { js: `#!/usr/bin/env node\n"use strict";\nif (process.argv.length === 3 && process.argv[2] === "--licenses") { const sea = require("node:sea"); const nodeNotice = sea.isSea() ? "\\n\\n## Bundled Node.js runtime\\n\\n" + sea.getAsset("zcode-node-license", "utf8") : ""; process.stdout.write(${JSON.stringify(notices)} + nodeNotice, () => process.exit(0)); } else {` },
    footer: { js: "}" },
    plugins: [
      { name: "xiadie-protocol-factory", setup(builder) {
        builder.onResolve({ filter: /^p01:factory$/ }, () => ({ path: factoryEntry }));
        builder.onLoad({ filter: /zcode-protocol-entrypoint\.js$/ }, async (args) => {
          assert.equal(path.resolve(args.path), targetProtocol);
          const original = await readFile(args.path, "utf8");
          assert.equal(original.split(needle).length, 2, "Pinned protocol factory import changed");
          const contents = original.replace(needle, 'import { createZCodeApp } from "p01:factory";');
          patches += 1;
          patchBinding = { file: targetProtocol, originalSha256: digest(original), patchedSha256: digest(contents) };
          return { contents, loader: "js", resolveDir: path.dirname(args.path) };
        });
      } },
      nativeBuild.createZodDedupePlugin({ expectedV4Version: expectedZod }),
    ],
  });
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
  const artifacts = await bindTree(assemblyRoot);
  const descriptor = {
    schemaVersion: 1,
    sourceCommit: SOURCE_PIN,
    sourceRoot: physicalSource,
    repositoryCommit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
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
    nodeVersion,
    artifacts,
    scope: "Local development candidate with borrowed pinned dependencies; not a portable installer. U08 base manifest precedes the CLI overlay; this descriptor binds final files and excludes itself.",
  };
  await save(path.join(assemblyRoot, "candidate-descriptor.json"), descriptor);
  return descriptor;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") throw new Error("usage: node tests/integration/P01/build-candidate.mjs --output <new absolute directory>");
  const candidate = await buildCandidate({ destination: args[1] });
  console.log(JSON.stringify({ candidate: await binding(path.join(candidate.assemblyRoot, "candidate-descriptor.json")), artifacts: candidate.artifacts.length, cliSha256: candidate.cli.sha256 }));
}
