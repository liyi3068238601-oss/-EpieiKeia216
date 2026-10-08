import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u04");
mkdirSync(experimentRoot, { recursive: true });

// Native helpers run only after this process has an allowlisted, owned environment.
const environmentRoot = mkdtempSync(path.join(experimentRoot, "reader-env-"));
const syntheticHome = path.join(environmentRoot, "home");
const syntheticTemp = path.join(environmentRoot, "temp");
const syntheticAppData = path.join(syntheticHome, "AppData", "Roaming");
const syntheticLocalAppData = path.join(syntheticHome, "AppData", "Local");
mkdirSync(syntheticTemp, { recursive: true });
mkdirSync(syntheticAppData, { recursive: true });
mkdirSync(syntheticLocalAppData, { recursive: true });
const inherited = process.env;
const safeEnvironment = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
  if (typeof inherited[name] === "string") safeEnvironment[name] = inherited[name];
}
Object.assign(safeEnvironment, {
  HOME: syntheticHome,
  USERPROFILE: syntheticHome,
  APPDATA: syntheticAppData,
  LOCALAPPDATA: syntheticLocalAppData,
  TEMP: syntheticTemp,
  TMP: syntheticTemp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(environmentRoot, "disabled-global-git-config"),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, safeEnvironment);

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(testDirectory, "../../../..");
const registryModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href;
const { openProjectRegistry } = await import(registryModuleUrl);

const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const tsxApiUrl = pathToFileURL(path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const nativeMemoryRootUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js")).href;
const nativePathsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "app", "paths.js")).href;
const [{ resolveProjectMemoryRoot }, { projectIdFromDirectory }] = await Promise.all([
  import(nativeMemoryRootUrl),
  import(nativePathsUrl),
]);

const readerModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "adapters", "zcode", "src", "project-memory.js")).href;
const { createProjectMemoryReader } = await import(readerModuleUrl);

function fixture(label) {
  const root = mkdtempSync(path.join(experimentRoot, `${label}-`));
  const ownedDirectory = path.join(root, "registry");
  const nativeStorageRoot = path.join(root, "native-cli");
  const noHooks = path.join(root, "empty-hooks");
  mkdirSync(ownedDirectory);
  mkdirSync(nativeStorageRoot);
  mkdirSync(noHooks);
  return { root, ownedDirectory, nativeStorageRoot, noHooks };
}

function git(f, cwd, args) {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${f.noHooks}`,
    "-c", "user.name=P03 U04 Synthetic Author",
    "-c", "user.email=p03-u04@example.invalid",
    "-c", "commit.gpgSign=false",
    "-C", cwd,
    ...args,
  ], {
    cwd: f.root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    throw new Error(`Synthetic Git command failed (${args.join(" ")}): ${detail}`);
  }
  return result.stdout.trim();
}

function initRepository(f, directory) {
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: true });
  git(f, f.root, ["init", "--initial-branch=main", directory]);
  writeFileSync(path.join(directory, "README.txt"), "synthetic P03-U04 workspace\n", "utf8");
  git(f, directory, ["add", "README.txt"]);
  git(f, directory, ["commit", "-m", "synthetic U04 fixture"]);
  return directory;
}

function openRegistry(f, t) {
  const registry = openProjectRegistry({
    ownedDirectory: f.ownedDirectory,
    nativeStorageRoot: f.nativeStorageRoot,
    nativeMemoryRootResolver: resolveProjectMemoryRoot,
    nativeRuntimeKeyResolver: projectIdFromDirectory,
  });
  t.after(() => registry.close());
  return registry;
}

function addProject(f, registry, name) {
  const workspacePath = initRepository(f, path.join(f.root, "repos", name, "same-name"));
  const mapping = registry.registerWorkspace({ workspacePath });
  return { workspacePath, mapping, memoryRoot: mapping.native.memoryRoot };
}

function memoryReader(registry, project, selectedPaths = []) {
  return createProjectMemoryReader({
    registry,
    workspacePath: project.workspacePath,
    selectedTopics: () => selectedPaths,
  });
}

function writeIndex(project, value) {
  mkdirSync(project.memoryRoot, { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  writeFileSync(path.join(project.memoryRoot, "MEMORY.md"), bytes);
  return bytes;
}

function writeTopic(project, relativePath, value) {
  const target = memoryFile(project, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function memoryFile(project, relativePath) {
  return path.join(project.memoryRoot, ...relativePath.split("/"));
}

function sourceFor(snapshot, relativePath) {
  const source = snapshot.topics.find(item => item.path === relativePath);
  assert.ok(source, `snapshot is missing topic ${relativePath}`);
  return source;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(filename) {
  return sha256(readFileSync(filename));
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, "every snapshot object and array must be frozen");
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function findTextObject(value, text, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value) && value.text === text) return value;
  for (const child of Object.values(value)) {
    const found = findTextObject(child, text, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function expectThrown(action, label) {
  assert.throws(action, error => error instanceof Error, label);
}

test("present capture preserves raw hashes/frontmatter and reads only selected direct/reference topics", t => {
  const f = fixture("present-indexed-topics-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "present");
  const indexText = [
    "# U04_INDEX_RAW_SENTINEL stays outside packet content",
    "",
    "<!-- [ignored comment](../escape-comment.md) -->",
    "Inline code: `[ignored inline](../escape-inline.md)`.",
    "",
    "```markdown",
    "[ignored fenced link](../escape-fence.md)",
    "```",
    "",
    "<a href=\"../escape-html.md\">ignored HTML link</a>",
    "",
    "[reference topic][reference]",
    "[direct topic](topics/direct.md#section)",
    "[unselected large topic](topics/unselected-large.md)",
    "",
    "[reference]: topics/reference.md#part",
    "",
  ].join("\r\n");
  const indexBytes = writeIndex(project, indexText);
  const frontmatter = "\uFEFF---\r\ntitle: U04 raw frontmatter\r\nlabels:\r\n  - lead\r\n---\r\n";
  const referenceText = `${frontmatter}# Selected reference topic\r\nBody bytes stay intact.\r\n`;
  const directText = "# Selected direct topic\nDirect body.\n";
  const referenceBytes = Buffer.from(referenceText, "utf8");
  const directBytes = Buffer.from(directText, "utf8");
  writeTopic(project, "topics/reference.md", referenceBytes);
  writeTopic(project, "topics/direct.md", directBytes);
  writeTopic(project, "topics/unselected-large.md", `U04_UNSELECTED_SENTINEL${"x".repeat(33_000)}`);

  const selected = ["topics/reference.md", "topics/direct.md"];
  const reader = memoryReader(registry, project, selected);
  const snapshot = reader.capture();
  assert.equal(snapshot.kind, "present");
  assert.equal(snapshot.index.kind, "present");
  assert.equal(snapshot.index.source_hash, sha256(indexBytes));
  assert.equal(snapshot.project_id, project.mapping.projectId);
  assert.deepEqual(Object.keys(snapshot.data).sort(), ["content", "evidence", "state"]);
  assert.ok(Array.isArray(snapshot.data.state));
  assert.ok(Array.isArray(snapshot.data.evidence));
  assert.ok(Array.isArray(snapshot.data.content));
  assert.deepEqual(snapshot.topics.map(item => item.path).sort(), [...selected].sort());

  const reference = sourceFor(snapshot, "topics/reference.md");
  const direct = sourceFor(snapshot, "topics/direct.md");
  assert.equal(reference.kind, "present");
  assert.equal(reference.text, referenceText);
  assert.equal(reference.frontmatter, frontmatter);
  assert.equal(reference.sizeBytes, referenceBytes.byteLength);
  assert.equal(reference.source_hash, sha256(referenceBytes));
  assert.equal(direct.text, directText);
  assert.equal(direct.source_hash, sha256(directBytes));
  assert.equal(reader.read(snapshot, memoryFile(project, reference.path)).text, referenceText);
  assert.equal(reader.read(snapshot, memoryFile(project, direct.path)).text, directText);
  expectThrown(() => reader.read(snapshot, memoryFile(project, "topics/unselected-large.md")), "unselected files cannot be read through a snapshot");

  const dataJson = JSON.stringify(snapshot.data);
  assert.equal(dataJson.includes("U04_INDEX_RAW_SENTINEL"), false, "the raw MEMORY.md index is not packet content");
  assert.equal(dataJson.includes("U04_UNSELECTED_SENTINEL"), false, "an unselected oversized file is not read or included");
  assert.ok(findTextObject(snapshot.data.content, referenceText), "selected topic text and frontmatter belong in content");
  const refs = snapshot.data.content.flatMap(record => record.source_refs);
  assert.ok(refs.length > 0);
  assert.ok(refs.every(ref => Buffer.byteLength(ref, "utf8") <= 512));
  assert.ok(refs.some(ref => ref.includes(project.mapping.projectId) && ref.includes(reference.path) && ref.includes(reference.source_hash)));
});

test("a missing index is absent without creating memory files; an empty valid index is present", t => {
  const f = fixture("absent-and-empty-index-");
  const registry = openRegistry(f, t);
  const absentProject = addProject(f, registry, "absent");
  assert.equal(existsSync(absentProject.memoryRoot), false);
  const absent = memoryReader(registry, absentProject).capture();
  assert.equal(absent.kind, "absent");
  assert.equal(absent.index.kind, "absent");
  assert.deepEqual(absent.topics, []);
  assert.equal(existsSync(absentProject.memoryRoot), false);

  const emptyProject = addProject(f, registry, "empty");
  writeIndex(emptyProject, "# Empty but valid memory index\nNo topic links yet.\n");
  const empty = memoryReader(registry, emptyProject).capture();
  assert.equal(empty.kind, "present");
  assert.equal(empty.index.kind, "present");
  assert.deepEqual(empty.topics, []);
});

test("index frontmatter is bounded YAML and malformed metadata is read-only corruption", async t => {
  const f = fixture("index-frontmatter-validation-");
  const registry = openRegistry(f, t);
  const cases = [
    ["malformed YAML", "---\ntitle: [unterminated\n---\n# Body\n"],
    ["truncated delimiter", "---\ntitle: unfinished\n# Body\n"],
    ["forbidden YAML alias", "---\nbase: &shared marker\ncopy: *shared\n---\n# Body\n"],
    ["frontmatter bound", `---\nnote: ${"x".repeat(8_200)}\n---\n# Body\n`],
  ];
  for (const [label, text] of cases) {
    await t.test(label, () => {
      const project = addProject(f, registry, `index-frontmatter-${label.replaceAll(/[^a-z0-9]+/gi, "-")}`);
      const bytes = writeIndex(project, text);
      const filename = memoryFile(project, "MEMORY.md");
      const beforeEntries = readdirSync(project.memoryRoot).sort();
      const beforeHash = sha256(bytes);
      const snapshot = memoryReader(registry, project).capture();
      assert.equal(snapshot.kind, "corrupt");
      assert.equal(snapshot.index.kind, "corrupt");
      assert.equal(snapshot.index.source_hash, beforeHash);
      assert.equal(hashFile(filename), beforeHash, "capture must not rewrite malformed source bytes");
      assert.deepEqual(readdirSync(project.memoryRoot).sort(), beforeEntries,
        "capture must not create repair or sidecar files for malformed source");
    });
  }
});

test("only body Markdown links authorize topics; frontmatter text cannot become a topic pointer", t => {
  const f = fixture("index-frontmatter-link-scope-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "index-frontmatter-link-scope");
  writeIndex(project, [
    "---",
    "references:",
    '  - "[hidden](topics/not-authorized.md)"',
    "---",
    "# Memory index",
    "[allowed body reference][allowed]",
    "",
    "[allowed]: topics/body-authorized.md#section",
    "",
  ].join("\n"));
  writeTopic(project, "topics/not-authorized.md", "frontmatter-only target\n");
  writeTopic(project, "topics/body-authorized.md", "body reference target\n");

  let selected = ["topics/not-authorized.md"];
  const reader = createProjectMemoryReader({ registry, workspacePath: project.workspacePath, selectedTopics: () => selected });
  const hidden = reader.capture();
  assert.equal(hidden.kind, "corrupt");
  assert.equal(hidden.index.kind, "present", "the index frontmatter itself is valid YAML");
  assert.equal(sourceFor(hidden, "topics/not-authorized.md").code, "NOT_INDEXED");

  selected = ["topics/body-authorized.md"];
  const body = reader.capture();
  assert.equal(body.kind, "present");
  assert.deepEqual(body.topics.map(item => item.path), ["topics/body-authorized.md"],
    "capture includes only selected body links");
  assert.equal(sourceFor(body, "topics/body-authorized.md").kind, "present");
  assert.equal(JSON.stringify(body.data).includes("frontmatter-only target"), false,
    "frontmatter links cannot add content outside the selected topic set");
  expectThrown(() => reader.read(body, memoryFile(project, "topics/not-authorized.md")),
    "a frontmatter-only link cannot authorize a filesystem Read");
  assert.equal(reader.read(body, memoryFile(project, "topics/body-authorized.md")).text, "body reference target\n");
});

test("two same-named projects keep opposite same-path topics isolated", t => {
  const f = fixture("same-name-project-isolation-");
  const registry = openRegistry(f, t);
  const projectA = addProject(f, registry, "project-a");
  const projectB = addProject(f, registry, "project-b");
  assert.equal(path.basename(projectA.workspacePath), path.basename(projectB.workspacePath));
  assert.equal(projectA.mapping.workspaces[0].nativeRuntimeKey, projectB.mapping.workspaces[0].nativeRuntimeKey,
    "these long shared paths collide under the actual Native runtime-key helper");
  assert.notEqual(projectA.mapping.projectId, projectB.mapping.projectId);
  assert.notEqual(projectA.memoryRoot, projectB.memoryRoot);

  const relative = "topics/shared.md";
  const index = "# Shared relative topic\n[shared](topics/shared.md)\n";
  writeIndex(projectA, index);
  writeIndex(projectB, index);
  const textA = "# Project A\nA_ONLY_AUTHORITY\n";
  const textB = "# Project B\nB_ONLY_AUTHORITY\n";
  writeTopic(projectA, relative, textA);
  writeTopic(projectB, relative, textB);

  const readerA = memoryReader(registry, projectA, [relative]);
  const readerB = memoryReader(registry, projectB, [relative]);
  const snapshotA = readerA.capture();
  const snapshotB = readerB.capture();
  assert.equal(snapshotA.kind, "present");
  assert.equal(snapshotB.kind, "present");
  assert.equal(sourceFor(snapshotA, relative).text, textA);
  assert.equal(sourceFor(snapshotB, relative).text, textB);
  assert.equal(JSON.stringify(snapshotA.data).includes("B_ONLY_AUTHORITY"), false);
  assert.equal(JSON.stringify(snapshotB.data).includes("A_ONLY_AUTHORITY"), false);
});

test("invalid UTF-8 and malformed or aliased YAML frontmatter are corrupt", async t => {
  const f = fixture("encoding-and-frontmatter-");
  const registry = openRegistry(f, t);
  const cases = [
    ["invalid UTF-8", Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a])],
    ["truncated YAML", "---\ntitle: [unterminated\n---\nbody\n"],
    ["forbidden YAML alias", "---\nbase: &shared marker\ncopy: *shared\n---\nbody\n"],
    ["missing closing delimiter", "---\ntitle: no-close\nbody\n"],
  ];
  for (const [label, bytes] of cases) {
    await t.test(label, () => {
      const project = addProject(f, registry, `invalid-${label.replaceAll(/[^a-z0-9]+/gi, "-")}`);
      writeIndex(project, "# Encoding and frontmatter\n[topic](topics/topic.md)\n");
      writeTopic(project, "topics/topic.md", bytes);
      const snapshot = memoryReader(registry, project, ["topics/topic.md"]).capture();
      assert.equal(snapshot.kind, "corrupt");
      const source = sourceFor(snapshot, "topics/topic.md");
      assert.equal(source.kind, "corrupt");
      if (label === "invalid UTF-8") assert.equal(source.source_hash, sha256(bytes));
    });
  }
});

test("unsafe Markdown destinations corrupt the index even when no topic is selected", async t => {
  const f = fixture("unsafe-index-links-");
  const registry = openRegistry(f, t);
  const cases = [
    ["external protocol", "https://example.invalid/topic.md"],
    ["relative traversal", "../outside.md"],
    ["percent-decoded traversal", "%2e%2e/outside.md"],
    ["absolute POSIX path", "/outside.md"],
    ["absolute drive path", "C:/outside.md"],
    ["encoded backslash", "topics%5coutside.md"],
    ["alternate data stream", "topics/note.md:secret"],
    ["malformed URL escape", "topics/%ZZ.md"],
    ["non-Markdown target", "topics/note.txt"],
    ["Windows device name", "topics/CON.md"],
    ["trailing-dot alias", "topics/note.md."],
  ];
  for (const [label, destination] of cases) {
    await t.test(label, () => {
      const name = `unsafe-${label.replaceAll(/[^a-z0-9]+/gi, "-")}`;
      const project = addProject(f, registry, name);
      writeIndex(project, `# Malformed unselected link\n[bad](${destination})\n`);
      const snapshot = memoryReader(registry, project).capture();
      assert.equal(snapshot.kind, "corrupt");
    });
  }
});

test("selected paths require exact index membership and exact on-disk case", async t => {
  const f = fixture("selected-path-validation-");
  const registry = openRegistry(f, t);
  await t.test("selected path is absent from the index", () => {
    const project = addProject(f, registry, "not-indexed");
    writeIndex(project, "# Index\n[listed](topics/listed.md)\n");
    writeTopic(project, "topics/not-listed.md", "not selected by the index\n");
    const snapshot = memoryReader(registry, project, ["topics/not-listed.md"]).capture();
    assert.equal(snapshot.kind, "corrupt");
  });
  await t.test("case-insensitive Windows lookup does not excuse wrong component case", () => {
    const project = addProject(f, registry, "wrong-case");
    writeIndex(project, "# Index\n[wrong case](Topics/selected.md)\n");
    writeTopic(project, "topics/selected.md", "actual on-disk case is lowercase\n");
    const snapshot = memoryReader(registry, project, ["Topics/selected.md"]).capture();
    assert.equal(snapshot.kind, "corrupt");
  });
});

test("a junction cannot escape the physical project memory root", t => {
  const f = fixture("junction-containment-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "junction");
  const outside = path.join(f.root, "outside-target");
  const junction = path.join(project.memoryRoot, "topics", "junction");
  mkdirSync(outside, { recursive: true });
  mkdirSync(path.dirname(junction), { recursive: true });
  const outsideFile = path.join(outside, "outside.md");
  writeFileSync(outsideFile, "U04_OUTSIDE_TARGET_MUST_NOT_BE_READ\n", "utf8");
  const outsideHash = hashFile(outsideFile);
  symlinkSync(outside, junction, "junction");
  writeIndex(project, "# Index\n[escape](topics/junction/outside.md)\n");

  const snapshot = memoryReader(registry, project, ["topics/junction/outside.md"]).capture();
  assert.equal(snapshot.kind, "corrupt");
  assert.equal(sourceFor(snapshot, "topics/junction/outside.md").source_hash, null);
  assert.equal(hashFile(outsideFile), outsideHash);
});

test("index, topic, frontmatter, and selected-topic bounds fail closed", async t => {
  const f = fixture("reader-bounds-");
  const registry = openRegistry(f, t);
  const cases = [
    ["index byte limit", project => writeIndex(project, Buffer.alloc(32_769, 0x78)), []],
    ["index line limit", project => writeIndex(project, `${"plain line\n".repeat(201)}`), []],
    ["topic byte limit", project => {
      writeIndex(project, "# Index\n[large](topics/large.md)\n");
      writeTopic(project, "topics/large.md", Buffer.alloc(32_769, 0x61));
    }, ["topics/large.md"]],
    ["frontmatter byte limit", project => {
      writeIndex(project, "# Index\n[large frontmatter](topics/frontmatter.md)\n");
      writeTopic(project, "topics/frontmatter.md", `---\nnote: ${"x".repeat(8_200)}\n---\nbody\n`);
    }, ["topics/frontmatter.md"]],
    ["selected topic count", project => {
      const paths = Array.from({ length: 9 }, (_, index) => `topics/topic-${index}.md`);
      writeIndex(project, `# Index\n${paths.map((item, index) => `[topic ${index}](${item})`).join("\n")}\n`);
      for (const item of paths) writeTopic(project, item, "# Small topic\n");
    }, Array.from({ length: 9 }, (_, index) => `topics/topic-${index}.md`)],
  ];
  for (const [label, prepare, selected] of cases) {
    await t.test(label, () => {
      const project = addProject(f, registry, `limit-${label.replaceAll(/[^a-z0-9]+/gi, "-")}`);
      prepare(project);
      const snapshot = memoryReader(registry, project, selected).capture();
      assert.equal(snapshot.kind, "corrupt");
    });
  }
});

test("a selected index pointer to a missing topic is corrupt and has no fabricated hash", t => {
  const f = fixture("broken-pointer-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "broken-pointer");
  writeIndex(project, "# Index\n[missing](topics/missing.md)\n");

  const reader = memoryReader(registry, project, ["topics/missing.md"]);
  const snapshot = reader.capture();
  assert.equal(snapshot.kind, "corrupt");
  const missing = sourceFor(snapshot, "topics/missing.md");
  assert.equal(missing.kind, "corrupt");
  assert.equal(missing.source_hash, null);
  expectThrown(() => reader.read(snapshot, memoryFile(project, "topics/missing.md")));
});

test("snapshots are deeply frozen and neither JSON clones nor another reader can authorize Read", t => {
  const f = fixture("snapshot-authority-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "snapshot-authority");
  const relative = "topics/selected.md";
  const text = "# Frozen topic\nDeep snapshot content.\n";
  writeIndex(project, `# Index\n[selected](${relative})\n`);
  writeTopic(project, relative, text);

  const reader = memoryReader(registry, project, [relative]);
  const otherReader = memoryReader(registry, project, [relative]);
  const snapshot = reader.capture();
  assert.equal(snapshot.kind, "present");
  assertDeepFrozen(snapshot);
  assert.throws(() => { sourceFor(snapshot, relative).text = "tampered"; }, TypeError);
  const dataText = findTextObject(snapshot.data, text);
  assert.ok(dataText, "the selected full topic text must be represented in data.content");
  assert.throws(() => { dataText.text = "tampered"; }, TypeError);

  const selectedFilename = memoryFile(project, relative);
  assert.equal(reader.read(snapshot, selectedFilename).text, text);
  expectThrown(() => otherReader.read(snapshot, selectedFilename), "snapshots are scoped to the reader that captured them");
  expectThrown(() => reader.read(JSON.parse(JSON.stringify(snapshot)), selectedFilename), "serialized snapshots cannot authorize Read");
});

test("a source change invalidates its old snapshot and a new capture reads repaired bytes", t => {
  const f = fixture("source-change-refresh-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "source-change");
  const relative = "topics/current.md";
  const filename = memoryFile(project, relative);
  const oldText = "# Version one\nOLD_SOURCE_BYTES\n";
  const newText = "# Version two\nNEW_SOURCE_BYTES\n";
  writeIndex(project, `# Index\n[current](${relative})\n`);
  writeTopic(project, relative, oldText);

  const reader = memoryReader(registry, project, [relative]);
  const admitted = reader.capture();
  const oldSource = sourceFor(admitted, relative);
  assert.equal(oldSource.source_hash, sha256(Buffer.from(oldText, "utf8")));
  assert.equal(reader.read(admitted, filename).text, oldText);

  writeFileSync(filename, newText, "utf8");
  expectThrown(() => reader.read(admitted, filename), "the admitted snapshot cannot authorize changed source bytes");
  const fresh = reader.capture();
  assert.equal(fresh.kind, "present");
  assert.equal(sourceFor(fresh, relative).source_hash, sha256(Buffer.from(newText, "utf8")));
  assert.equal(reader.read(fresh, filename).text, newText);
});

test("capture detects index and selected-topic changes during its final consistency check", async t => {
  const f = fixture("capture-consistency-race-");
  const registry = openRegistry(f, t);
  const cases = [
    ["index mutation", (project, relative) => writeIndex(project, `# Changed index\n[selected](${relative})\n`)],
    ["selected topic mutation", (project, relative) => writeTopic(project, relative, "# Changed after initial read\n")],
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const project = addProject(f, registry, `race-${label.replaceAll(/[^a-z0-9]+/gi, "-")}`);
      const relative = "topics/selected.md";
      writeIndex(project, `# Initial index\n[selected](${relative})\n`);
      writeTopic(project, relative, "# Initial topic\n");

      const ownMethod = Object.getOwnPropertyDescriptor(registry, "resolveWorkspace");
      const realResolve = registry.resolveWorkspace.bind(registry);
      let resolutions = 0;
      // A real branded mapping is returned every time; only the second resolve
      // synchronously mutates this owned fixture to model capture-time drift.
      Object.defineProperty(registry, "resolveWorkspace", {
        configurable: true,
        writable: true,
        value: workspacePath => {
          const mapping = realResolve(workspacePath);
          if (++resolutions === 2) mutate(project, relative);
          return mapping;
        },
      });

      let snapshot;
      try {
        snapshot = memoryReader(registry, project, [relative]).capture();
      } finally {
        if (ownMethod === undefined) delete registry.resolveWorkspace;
        else Object.defineProperty(registry, "resolveWorkspace", ownMethod);
      }
      assert.equal(resolutions, 2, "capture re-resolves the actual registry mapping before returning");
      assert.equal(snapshot.kind, "corrupt");
      assert.equal(snapshot.code, "SOURCE_CHANGED");
      assert.equal(sourceFor(snapshot, relative).code, "SOURCE_CHANGED");
    });
  }
});

const ACL_HELPER = String.raw`param(
  [Parameter(Mandatory=$true)][ValidateSet('get','deny','restore')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$SavedDaclBase64
)
$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Access
switch ($Action) {
  'get' {
    $acl = Get-Acl -LiteralPath $Target
    $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($sddl)))
  }
  'deny' {
    $acl = Get-Acl -LiteralPath $Target
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::ReadData, [System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
  'restore' {
    $saved = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($SavedDaclBase64))
    $acl = Get-Acl -LiteralPath $Target
    $acl.SetSecurityDescriptorSddlForm($saved, $sections)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
}`;

function runAclHelper(f, scriptPath, action, target, savedDaclBase64 = "") {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-Action", action, "-Target", target, "-SavedDaclBase64", savedDaclBase64,
  ], {
    cwd: f.root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    // ACLs and SIDs are deliberately kept out of test output, even on failure.
    throw new Error(`Synthetic ACL ${action} operation failed (exit ${result.status ?? "spawn"})`);
  }
  return result.stdout.trim();
}

test("an actual Windows ACL denial returns unreadable, then finally restores the owned topic DACL", t => {
  const f = fixture("acl-unreadable-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "acl");
  const relative = "topics/denied.md";
  const filename = writeTopic(project, relative, "# Protected synthetic topic\nACL_RESTORE_CANARY\n");
  writeIndex(project, `# Index\n[denied](${relative})\n`);
  const originalBytesHash = hashFile(filename);
  const scriptPath = path.join(f.root, "owned-acl-fixture.ps1");
  writeFileSync(scriptPath, ACL_HELPER, "utf8");
  const savedDaclBase64 = runAclHelper(f, scriptPath, "get", filename);
  assert.ok(savedDaclBase64.length > 0);
  const originalDaclHash = sha256(Buffer.from(savedDaclBase64, "base64"));
  const reader = memoryReader(registry, project, [relative]);

  try {
    runAclHelper(f, scriptPath, "deny", filename);
    const denied = reader.capture();
    assert.equal(denied.kind, "unreadable");
    assert.equal(denied.index.kind, "present");
    assert.equal(sourceFor(denied, relative).kind, "unreadable");
    assert.equal(sourceFor(denied, relative).source_hash, null);
  } finally {
    runAclHelper(f, scriptPath, "restore", filename, savedDaclBase64);
  }

  const restoredDaclBase64 = runAclHelper(f, scriptPath, "get", filename);
  assert.equal(sha256(Buffer.from(restoredDaclBase64, "base64")), originalDaclHash,
    "the DACL must match its pre-denial fingerprint after finally restoration");
  assert.equal(hashFile(filename), originalBytesHash, "ACL testing must not alter the synthetic topic bytes");
  const recovered = reader.capture();
  assert.equal(recovered.kind, "present");
  assert.equal(reader.read(recovered, filename).text, "# Protected synthetic topic\nACL_RESTORE_CANARY\n");
});
