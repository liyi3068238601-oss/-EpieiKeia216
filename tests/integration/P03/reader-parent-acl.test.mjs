import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(testDirectory, "../../..");
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u09");
const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const aclHelper = path.join(testDirectory, "reader-parent-acl-helper.ps1");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeCode(error) {
  return typeof error?.code === "string" ? error.code : "ERROR";
}

function runGit(fixtureRoot, noHooks, cwd, args) {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${noHooks}`,
    "-c", "user.name=P03 U09 Synthetic Author",
    "-c", "user.email=p03-u09@example.invalid",
    "-c", "commit.gpgSign=false",
    "-C", cwd,
    ...args,
  ], {
    cwd: fixtureRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Owned synthetic Git command failed (${safeCode(result.error ?? { code: "GIT_FAILED" })})`);
  }
  return result.stdout.trim();
}

function runAcl(action, target, savedDaclBase64 = "") {
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", aclHelper,
    "-Action", action, "-Target", target, "-SavedDaclBase64", savedDaclBase64,
  ], {
    cwd: testDirectory,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    // Never include ACL text, SIDs, or PowerShell diagnostics in test output.
    throw new Error(`Owned synthetic ACL ${action} failed (${safeCode(result.error ?? { code: `ACL_${action.toUpperCase()}_FAILED` })})`);
  }
  return result.stdout.trim();
}

function sourceFor(snapshot, relativePath) {
  const source = snapshot.topics.find(item => item.path === relativePath);
  assert.ok(source, `snapshot is missing selected topic ${relativePath}`);
  return source;
}

test("capture revalidation preserves unreadable ACL failures and clears unverified content", {
  skip: process.platform === "win32" ? false : "requires a real Windows filesystem DACL",
}, async t => {
  assert.match(process.version, /^v24\.14\./, "run with the fixed Node 24.14 toolchain");
  mkdirSync(experimentRoot, { recursive: true });

  const environmentRoot = mkdtempSync(path.join(experimentRoot, "reader-parent-acl-"));
  const fixtureRoot = path.join(environmentRoot, "owned-fixture");
  const ownedDirectory = path.join(fixtureRoot, "registry");
  const nativeStorageRoot = path.join(fixtureRoot, "native-cli");
  const noHooks = path.join(fixtureRoot, "empty-hooks");
  const workspacePath = path.join(fixtureRoot, "repos", "synthetic", "workspace");
  const syntheticHome = path.join(environmentRoot, "home");
  const syntheticTemp = path.join(environmentRoot, "temp");
  const appData = path.join(syntheticHome, "AppData", "Roaming");
  const localAppData = path.join(syntheticHome, "AppData", "Local");
  for (const directory of [ownedDirectory, nativeStorageRoot, noHooks, workspacePath, syntheticTemp, appData, localAppData]) {
    mkdirSync(directory, { recursive: true });
  }

  const inherited = process.env;
  const safeEnvironment = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (typeof inherited[name] === "string") safeEnvironment[name] = inherited[name];
  }
  Object.assign(safeEnvironment, {
    HOME: syntheticHome,
    USERPROFILE: syntheticHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: syntheticTemp,
    TMP: syntheticTemp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(environmentRoot, "disabled-global-git-config"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, safeEnvironment);

  const { register } = await import(pathToFileURL(
    path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs"),
  ).href);
  register();
  const [{ resolveProjectMemoryRoot }, { projectIdFromDirectory }] = await Promise.all([
    import(pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js")).href),
    import(pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "app", "paths.js")).href),
  ]);

  const [{ openProjectRegistry }, { createProjectMemoryReader }] = await Promise.all([
    import(pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href),
    import(pathToFileURL(path.join(worktreeRoot, "dist", "packages", "adapters", "zcode", "src", "project-memory.js")).href),
  ]);
  const makeReader = (registry, workspacePath, relativePath) => createProjectMemoryReader({
    registry,
    workspacePath,
    selectedTopics: () => [relativePath],
  });

  let registry;
  try {
    mkdirSync(workspacePath, { recursive: true });
    runGit(fixtureRoot, noHooks, workspacePath, ["init", "--initial-branch=main"]);
    writeFileSync(path.join(workspacePath, "README.txt"), "synthetic P03-U09 ACL workspace\n", "utf8");
    runGit(fixtureRoot, noHooks, workspacePath, ["add", "README.txt"]);
    runGit(fixtureRoot, noHooks, workspacePath, ["commit", "-m", "synthetic U09 fixture"]);

    registry = openProjectRegistry({
      ownedDirectory,
      nativeStorageRoot,
      nativeMemoryRootResolver: resolveProjectMemoryRoot,
      nativeRuntimeKeyResolver: projectIdFromDirectory,
    });
    const mapping = registry.registerWorkspace({ workspacePath });
    const memoryRoot = mapping.native.memoryRoot;
    const expectedMemoryRoot = path.join(nativeStorageRoot, "memories", "projects", mapping.native.key, "memory");
    const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    assert.equal(samePath(memoryRoot, expectedMemoryRoot), true);
    const memoriesDirectory = path.join(nativeStorageRoot, "memories");
    const projectsDirectory = path.join(memoriesDirectory, "projects");
    for (const directory of [memoryRoot, memoriesDirectory, projectsDirectory]) {
      assert.equal(path.resolve(directory).toLowerCase().startsWith(path.resolve(fixtureRoot).toLowerCase() + path.sep), true,
        "all ACL targets must be inside the owned synthetic fixture");
    }

    const relativeTopic = "topics/selected.md";
    const indexBytes = Buffer.from(`# Synthetic U09 memory\n[selected topic](${relativeTopic})\n`, "utf8");
    const topicBytes = Buffer.from("---\ntitle: Synthetic ACL topic\n---\n# Selected topic\nU09_ACL_CANARY\n", "utf8");
    const indexFilename = path.join(memoryRoot, "MEMORY.md");
    const topicFilename = path.join(memoryRoot, ...relativeTopic.split("/"));
    mkdirSync(path.dirname(topicFilename), { recursive: true });
    writeFileSync(indexFilename, indexBytes);
    writeFileSync(topicFilename, topicBytes);

    const indexHash = sha256(indexBytes);
    const topicHash = sha256(topicBytes);
    const initial = makeReader(registry, workspacePath, relativeTopic).capture();
    assert.equal(initial.kind, "present");
    assert.equal(initial.index.source_hash, indexHash);
    assert.equal(sourceFor(initial, relativeTopic).source_hash, topicHash);
    assert.equal(initial.data.content.length, 1);

    const scenarios = [
      { label: "memoryRoot", directory: memoryRoot },
      { label: "memories", directory: memoriesDirectory },
      { label: "projects", directory: projectsDirectory },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.label, () => {
        const originalDacl = runAcl("get", scenario.directory);
        assert.equal(/^[A-Za-z0-9+/]+={0,2}$/.test(originalDacl), true,
          "DACL helper must return only encoded ACL bytes");
        const originalDaclHash = sha256(Buffer.from(originalDacl, "base64"));
        const bytesBefore = {
          index: sha256(readFileSync(indexFilename)),
          topic: sha256(readFileSync(topicFilename)),
        };

        let resolveCalls = 0;
        let denialApplied = false;
        const hookedRegistry = {
          resolveWorkspace(requestedPath) {
            const actualMapping = registry.resolveWorkspace(requestedPath);
            resolveCalls += 1;
            if (resolveCalls === 2) {
              runAcl("deny", scenario.directory);
              denialApplied = true;
            }
            return actualMapping;
          },
        };
        const subject = makeReader(hookedRegistry, workspacePath, relativeTopic);
        let deniedSnapshot;
        let captureError;
        let restoredDaclHash;
        let restoreError;
        try {
          deniedSnapshot = subject.capture();
        } catch (error) {
          captureError = error;
        } finally {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              runAcl("restore", scenario.directory, originalDacl);
              restoredDaclHash = sha256(Buffer.from(runAcl("get", scenario.directory), "base64"));
              restoreError = undefined;
              if (restoredDaclHash === originalDaclHash) break;
              restoreError = "DACL_HASH_MISMATCH";
            } catch (error) {
              restoreError = safeCode(error);
            }
          }
        }

        assert.equal(restoredDaclHash, originalDaclHash, "finally must restore the exact original DACL fingerprint");
        assert.equal(restoreError, undefined, "DACL restoration must complete without an ACL helper error");
        assert.equal(denialApplied, true, "the actual deny must be applied after the first successful source read");
        assert.equal(resolveCalls, 2, "the deny must trigger during capture's final mapping revalidation");
        const deniedResolveCalls = resolveCalls;
        assert.equal(captureError, undefined, "capture should return a classified unreadable snapshot");
        assert.ok(deniedSnapshot);
        assert.equal(deniedSnapshot.kind, "unreadable");
        assert.equal(deniedSnapshot.code, "PERMISSION_DENIED");
        assert.equal(deniedSnapshot.index.kind, "unreadable");
        assert.equal(deniedSnapshot.index.code, "PERMISSION_DENIED");
        assert.equal(deniedSnapshot.index.source_hash, null);
        const deniedTopic = sourceFor(deniedSnapshot, relativeTopic);
        assert.equal(deniedTopic.kind, "unreadable");
        assert.equal(deniedTopic.code, "PERMISSION_DENIED");
        assert.equal(deniedTopic.source_hash, null);
        for (const source of [deniedSnapshot.index, deniedTopic]) {
          for (const field of ["text", "frontmatter", "sizeBytes", "mtimeMs"]) {
            assert.equal(Object.hasOwn(source, field), false, `unverified ${field} must be cleared`);
          }
        }
        assert.deepEqual(deniedSnapshot.data.content, [], "unverified topic content must not survive revalidation failure");
        assert.equal(deniedSnapshot.data.state[0].value.source_hash, null);
        assert.equal(sha256(readFileSync(indexFilename)), bytesBefore.index, "index fixture bytes must stay unchanged");
        assert.equal(sha256(readFileSync(topicFilename)), bytesBefore.topic, "topic fixture bytes must stay unchanged");
        assert.equal(bytesBefore.index, indexHash);
        assert.equal(bytesBefore.topic, topicHash);

        const recovered = subject.capture();
        assert.equal(recovered.kind, "present", "capture must recover after the original DACL returns");
        assert.equal(recovered.index.source_hash, indexHash);
        assert.equal(sourceFor(recovered, relativeTopic).source_hash, topicHash);
        assert.equal(recovered.data.content.length, 1);
        assert.equal(recovered.data.content[0].value.text, topicBytes.toString("utf8"));
        t.diagnostic(JSON.stringify({
          scenario: scenario.label,
          deniedKind: deniedSnapshot.kind,
          deniedCode: deniedSnapshot.code,
          originalDaclSha256: originalDaclHash,
          restoredDaclSha256: restoredDaclHash,
          indexSha256: bytesBefore.index,
          topicSha256: bytesBefore.topic,
          recoveredKind: recovered.kind,
          resolveCallsDuringDeniedCapture: deniedResolveCalls,
          totalResolveCallsAfterRecovery: resolveCalls,
          denialApplied,
          contentCleared: deniedSnapshot.data.content.length === 0,
        }));
      });
    }
  } finally {
    registry?.close();
  }
});
