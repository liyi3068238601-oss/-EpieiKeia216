# U04 scope mapping

The immutable task card targets `packages/adapters/zcode/project-memory.ts`; actual implementation uses the existing `src/` layout. The accepted U02 ADR additionally maps the per-admission Host provider, trusted Hook data and direct parser dependencies. Baseline evidence records those files and mapped Node test selectors.

The independent Native Read precheck found a session-cache bypass: pinned Read calls `stat`, compares mtime/size and can skip `readTextFileRange`. A small production `packages/adapters/zcode/src/project-memory-port.ts` is therefore added to the declared implementation scope. Its memory stat and range paths both call the current Host's receipt-bound Read, and its optional-mtime-free revision includes the actual Read span ID, forcing each Read request through the range seam. This reuses the pinned Native FS extension point and does not modify upstream Read or its loop. Its source references and real-runtime acceptance belong in the final source/evidence records.

The bridge limits stat/range to the mapped project workspace and exact currently selected topics, and rejects missing/stale trace IDs. Other FS methods retain their existing contracts; this unit does not claim a complete filesystem write sandbox. U07 separately proves read-only reviewer tool/executor restrictions. Direct dependencies are Marked 16.4.2 (MIT) and yaml 2.9.0 (ISC), with exact lockfile and retained licenses.

Writers are separated: reader implementation in `project-memory.ts`; reader test author in `project-memory.test.mjs`; Host/port test author in `project-memory-host.test.mjs`; root owns Host, Hook, bridge, package/lock/licenses, selector and evidence. No planning-card, P01 factory, Native reference tree, user profile or production memory is modified.
