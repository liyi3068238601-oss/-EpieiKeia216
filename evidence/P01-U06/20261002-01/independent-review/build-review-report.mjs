import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve("E:/Xiadie/Xiadie");
const reviewRoot = path.join(repoRoot, ".runtime", "P01", "u06-final-review");
const projectRoot = path.join(repoRoot, ".runtime", "P01", "worktrees", "u06-review");
const reportPath = path.join(reviewRoot, "review-final.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relativePath = (absolute) => path.relative(repoRoot, absolute).replaceAll("\\", "/");
const artifactPaths = new Set([
  "AGENTS.md",
  "planning/Xiadie_V2_v1.1/tasks/P01-U06.md",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/src/host.ts",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/src/index.ts",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/test/host.test.mjs",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/test/contract.test.mjs",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/test/native.integration.test.mjs",
  ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/test/fixtures/hook-process-fault.mjs",
  ".runtime/P01/worktrees/u06-review/packages/character/src/loader.ts",
  ".runtime/P01/worktrees/u06-review/packages/context/src/index.ts",
  ".runtime/P01/worktrees/u06-review/packages/contracts/src/context.ts",
  ".runtime/P01/worktrees/u06-review/plugins/xiadie/.zcode-plugin/plugin.json",
  ".runtime/P01/worktrees/u06-review/plugins/xiadie/hooks/hooks.json",
  ".runtime/P01/worktrees/u06-review/plugins/xiadie/hooks/context.mjs",
  ".runtime/P01/worktrees/u06-review/plugins/xiadie/marketplace.json",
  ".runtime/P01/worktrees/u06-review/tools/run-tests.mjs",
  ".runtime/P01/worktrees/u06-review/tsconfig.json",
  ".runtime/P01/worktrees/u06-review/evidence/P01-U06/20261002-01/result.md",
  ".runtime/P01/worktrees/u06-review/evidence/P01-U06/20261002-01/manifest.json",
  ".runtime/P01/worktrees/u06/evidence/P01-U06/20261002-01/manifest.json",
]);

async function addTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      await addTree(absolute);
    } else if (item.isFile() && absolute !== reportPath) {
      artifactPaths.add(relativePath(absolute));
    }
  }
}
await addTree(reviewRoot);

const artifacts = [];
for (const filePath of [...artifactPaths].sort()) {
  const absolute = path.resolve(repoRoot, filePath);
  const bytes = await readFile(absolute);
  artifacts.push({ path: filePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const artifact = (filePath) => artifacts.find((item) => item.path === filePath);
const manifestArtifact = artifact(".runtime/P01/worktrees/u06-review/evidence/P01-U06/20261002-01/manifest.json");
const probeExecution = JSON.parse(await readFile(path.join(reviewRoot, "independent-review-05.execution.json"), "utf8"));
const probeResult = JSON.parse(await readFile(path.join(reviewRoot, "independent-review-05.stdout.log"), "utf8"));
const standardSummary = JSON.parse(await readFile(path.join(reviewRoot, "standard-run-summary.json"), "utf8"));

const report = {
  schema: "p01-independent-review/v1",
  decision: "pass",
  task: "P01-U06",
  review_target: {
    author_commit: "ef716c8a1ae4b0c67c9af9ea6d84fee809399d1a",
    baseline_commit: "f01f3d3551b55b8bde6889a940e9bcc68425240b",
    author_commit_parent_matches_baseline: true,
    author_worktree: ".runtime/P01/worktrees/u06",
    reviewer_worktree: ".runtime/P01/worktrees/u06-review",
    reviewer_worktree_clean_at_review: true,
    author_worktree_clean_at_review: true,
    author_manifest: {
      path: ".runtime/P01/worktrees/u06/evidence/P01-U06/20261002-01/manifest.json",
      files: 162,
      bytes: 42006,
      sha256: "524fc3fd2b6135f3dcff04d9b3c856ac9a2849baacb536d45c140500142db7a2",
      verification: "all 162 entries matched bytes, SHA-256, Git blob SHA-1, and the exact baseline-to-author changed path set excluding the manifest itself"
    }
  },
  source_review: [
    {
      path: ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/src/host.ts",
      areas: ["190-315 native app/facade and operation locks", "317-486 admission ticket and Hook gate", "487-550 model wrapper and receipt/compact gate", "554-637 Hook identity, transcript and receipt validation", "701-765 owned profile and physical storage boundary"],
      finding: "The host builds a fresh U04/U05 ContextPacket from the approved character with a per-admission nonce. It accepts only the installed UserPromptSubmit argv Hook, validates the full canonical packet and receipt against the native session/turn and a bounded transcript read, then checks the same native model-invocation context and packet at delegate time. Enabled sendInput forces requireIdle and releases the ticket/lock from native completion; compact admission binds to one session and compact turn and clears in finally. Disabled calls delegate through native methods. Admission failures are capped at 64 and retain hashes/correlation metadata rather than prompt or transcript content."
    },
    {
      path: ".runtime/P01/worktrees/u06-review/plugins/xiadie/hooks/context.mjs",
      areas: ["11-54 input, approved packet, transcript receipt and response", "57-100 strict aliases and bounded transcript read"],
      finding: "The process Hook validates native event/session/turn input, loads only the approved asset, rebuilds the packet with the host nonce, reads and hashes the bounded transient transcript, and emits the packet plus receipt without persisting transcript content."
    },
    {
      path: ".runtime/P01/worktrees/u06-review/packages/adapters/zcode/test/native.integration.test.mjs",
      finding: "The preserved integration fixture exercises the fixed native ZCode bootstrap and installed Hook process, including normal turn, sendInput, compact, resume, disabled mode, and malformed/missing/timeout Hook failure paths."
    }
  ],
  evidence_provenance: {
    standard_runs: "These are frozen raw outputs and execution JSON left by the independent reviewer whose turn was interrupted, in the same clean ef716c8 reviewer worktree. This recovery checked their hashes, exit codes, and pass/fail/skip counts; it did not rerun the standard commands.",
    self_probe: "The recovery added an in-process execution-port probe with explicit valid-envelope assertions. It tested foreign turn and foreign session receipts, fresh matching nonce receipts, and cleanup after a native compact failure."
  },
  verification: {
    frozen_install: { exit_code: 0, offline: true, ignore_scripts: true },
    check: {
      exit_code: 0,
      typescript: "passed",
      boundary_scan: { status: "not_run", reason: "packages/core is absent; the raw check output states no product Core imports were checked" }
    },
    build: { exit_code: 0 },
    standard_tests: [
      { id: "unit-u06", tests: 7, passed: 7, failed: 0, skipped: 0, exit_code: 0 },
      { id: "contract-u06", tests: 2, passed: 2, failed: 0, skipped: 0, exit_code: 0 },
      { id: "integration-u06", tests: 15, passed: 15, failed: 0, skipped: 0, exit_code: 0 }
    ],
    standard_run_ids: standardSummary.map((item) => ({ id: item.id, exit_code: item.exitCode })),
    standard_output_hashes_checked: true,
    reviewer_probe: {
      execution_path: relativePath(path.join(reviewRoot, "independent-review-05.execution.json")),
      exit_code: probeExecution.exitCode,
      result: probeResult.decision,
      manifest_paths_and_hashes_exact: probeResult.manifest.changedPathSet === "exact",
      cases: probeResult.probeResults
    }
  },
  probe_history: [
    { id: "independent-review", result: "harness_setup_failed", note: "Looked for preserved standard logs beneath the reviewer worktree instead of the supplied review evidence directory; no product probe ran." },
    { id: "independent-review-02", result: "probe_construction_failed", note: "The synthetic receipt used a contentSha256 property absent from the loaded character object and the cross-session case did not yet change the model trace session." },
    { id: "independent-review-03", result: "probe_construction_failed", note: "The foreign session case was corrected, but the synthetic receipt still omitted the approved content digest." },
    { id: "independent-review-04", result: "probe_construction_failed", note: "The approved digest reference was added before its import, causing a ReferenceError; no product defect was indicated." },
    { id: "independent-review-05", result: "pass", note: "Uses APPROVED_CHARACTER.contentSha256, asserts the Hook envelope contains canonical context and receipt (not a block response), and changes both foreign turn and foreign session traces." }
  ],
  limits: [
    "Native integration was run against the read-only ZCode source commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e with a loopback OpenAI-compatible mock. No paid model request or credentials were used.",
    "The native fixture did not verify Desktop GUI/CLI product assembly, DSH packaging, or a production profile.",
    "The boundary scan could not inspect packages/core because that package is absent.",
    "P01-U07 was not entered. G01 remains pending; this pass is only the independent U06 review decision before the coordinator's merge/regression and pause record."
  ],
  artifacts
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  report: relativePath(reportPath),
  bytes: (await stat(reportPath)).size,
  sha256: sha256(await readFile(reportPath)),
  artifactCount: artifacts.length,
  manifest: manifestArtifact,
  standardFiles: artifacts.filter((item) => item.path.startsWith(".runtime/P01/u06-final-review/")),
}, null, 2) + "\n");

