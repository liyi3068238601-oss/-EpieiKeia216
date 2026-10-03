# P02-U09 author result

Author status: ready_for_review. Baseline 99c8702a34660f36b528efa0cca8c7257e6f98a5, branch p02-u09; U08 is independently accepted. Acceptance of this exact author commit remains pending.

Implemented buildTurnDiagnostics from accepted U03 lifecycle projection, U05 read-only facts/observations/receipt readers and optional U06 EvidenceReports. The caller selects the exact four-field scope and attempt; any supplied report with a mismatched association rejects the complete request. Only committed writer order establishes lifecycle. Incomplete, corrupt or stalled streams explicitly remain partial and cannot establish lifecycle or turn sealing. Normal advancing pages are read through the existing conservative 32 x 256 per-stream cap, with additional 64 MiB stream bounds and bounded report/identifier counts.

The export constructs each field using a closed allowlist, finite numeric summaries and private per-report salted domain-separated references. References join related records inside one report and differ across reports. No raw IDs, paths, argv, input/reply/tool text, exception messages, hidden reasoning or unrelated memory content is exported. The accepted Native source pin and recovery adapter version are explicit; unknown pins are opaque references. Masked capture hashes/byte counts are retained, while the original temporary source remains currentValidation NOT_VERIFIED even after deletion. No original source is reopened.

Receipt verification matches actual scope/attempt, canonical writer receipt, operation kind/identity, success status and tool-call identity. A found receipt beyond a partial scan, or a failed receipt query, is unverified rather than falsely invalid/missing/verified. Exact scanned contradictions remain invalid. EvidenceReport profile summaries do not prove arbitrary business truth. turnSeal remains unavailable; no full conversation seal, memory/Dream/Life subsystem or Native integration is claimed here.

Scope: packages/diagnostics/, tsconfig.json source mapping, tools/run-tests.mjs selector/inventory and this evidence directory. Static migration source and accepted U01-U08/P01 inputs remain unchanged. No dependency installation, production data, credentials, paid calls or installed ZCode changes.

## Actual verification

Actual argv, cwd, timing, exit codes and outputs are archived byte-identically in commands/ and bound by command-index.json (10 records). Final commands use fixed Node v24.14.0 / TypeScript 6.0.2.

- 03-receipt-unverified-build.json: final source build, exit 0; SHA-256 409fd1987c9c484232e0f39b5b6fb039fa6acb7e25a2a06d021334293ffa60ef.
- 04-bind-pre.json / inputs-final-pre.json: 126 inputs including the static migration, digest eacb66d78f784afcccc7d21d185b44877be853a667ca4bd0c85ad3c4c9b76284.
- 05-final-unit.json: selector P02-U09, exit 0; 7/7 tests, zero failures/skips; record SHA-256 8c370ff7f1a89d43c7182f1c6eac7212c0ece8e08f76823a1efd4b441601216f.
- 06-bind-post.json / inputs-final-post.json: identical 126 inputs/digest, unchanged true.
- Final source SHA-256 e91e73753c37cf236720dc14abe38a2253c24b02c2b55cfeb2ff2b4f313a0f99.

Fixtures use actual U05 SQLite, real owned Node/Git U06 reports and actual receipt lookup. Cases cover exact scope/attempt filtering; canary omission and opaque-reference joins; deleted raw source remaining NOT_VERIFIED; direct default pagination across 258 facts/observations; report mismatch rejection and per-report ref variation; actual corrupted writer receipt; bounded partial/stalled paging; and a found receipt after 33 preceding facts excluded by a real page-size-one capped scan. This final regression reports unverified and unavailable lifecycle without invented receipt identity.

Failures are preserved: the first test run was 3/5 because a fixture passed the capture wrapper instead of its value and used a different run ID than the actual owned Node run. Corrected fixtures then passed 5/5, 6/6 after the direct pagination regression, and 7/7 after independent early review identified the partial-scan receipt boundary. The first unverified build had a TypeScript union mismatch (exit 2), corrected before the final build/tests. One root command-construction SyntaxError occurred before mapping modifications and was corrected with a saved helper. No test standard was lowered or failed output discarded. Successful synthetic roots are removed only after close and containment checks; failed roots and command evidence are retained.

## Limits and rollback

The reader/coordinator is trusted. Fixed paging/byte caps can intentionally leave large histories partial. Receipt/profile summaries establish the documented mechanical association only; current raw-source integrity and full business semantics remain unverified. SQLite experimental warnings are preserved. NOT_RUN: Native/Desktop composition (U10), paid models, physical storage failure, production data, installed ZCode, installer/portable release and full dependency closure.

Rollback only this isolated unit commit; preserve accepted U01-U08, frozen P01, original data and failed fixtures. U10 implementation requires independent exact-commit acceptance of U09. P03 has not started.
