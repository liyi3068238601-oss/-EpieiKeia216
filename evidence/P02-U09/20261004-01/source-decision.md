# Sources and scope decision

Reuse the accepted U01/U02 source investigation, existing Node runner/U06 owned-run WeakSet, U05 SQLite facts/origin/canonical-receipt lookup and U09 salted-reference allowlist. No new third-party dependency or source transplant is introduced. The original fixed source/permission/installation decisions remain in docs/research/P02/ and docs/sources.lock.json, bound by baseline.json.

The completion audit identified concrete data-loss at the existing U06 to U09 boundary and flattened Native tool facts. Keep metadata at its actual producer, then require committed receipt equality before exporting a verified command. Inferring commands from stdout, caller reports alone or terminal success was rejected because those are forgeable/insufficient. Version, argument count and salted script identity give a useful safe command summary without exposing paths or argument contents.

Native type/tool classification uses closed vocabularies and only exact accepted observations with the fixed ZCode commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e. Unknown tool names remain other. Memory candidate linking is an optional reference-only annotation contract, with explicit source verification status; adding a second memory store or trusting arbitrary candidate text was rejected. This closes U09's required source link without prematurely implementing P04 or duplicating native authority.

Mapping change: packages/application/evidence is necessary to retain actual command identity; tests/integration/P02/verify-ledger.mjs updates the diagnostic policy contract consumed by U10. Both paths are explicitly in baseline.json and the changed-file manifest. Existing Native/Electron assembly and owned profile/loopback isolation are reused later, after exact review acceptance.
