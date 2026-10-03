# P02-U06 source decision

**Status:** author evidence; source adoption does not constitute independent acceptance.

U06 uses the already accepted U03 event contract and U05 SQLite EventStore as the authoritative facts and persistence seams. U03 distinguishes an operation_receipt effect fact from storage-level (source,eventId) writer receipts; U05 supplies paged committed-fact reads, observation audit reads, and queryReceipt({source,eventId}). U06 therefore reads operation effects by operation ID and separately verifies each matching event through its source/event ID, first commit sequence, and canonical hash.

For owned-file reading, U06 follows the local filesystem ownership patterns already present in packages/adapters/zcode/src/transcript.ts: resolve beneath an owned root, reject linked/non-file paths, inspect an opened handle, bound the bytes read, and hash the actual bytes. It does not copy transcript data, raw logs, or user text into the report. The existing packages/application/turn-projection.ts remains a lifecycle/tool projection only; it is not used as business acceptance.

P02-U01/U02 research and the accepted docs/adr/P02-reuse.md favor thin project-owned evidence seams around the selected ZCode runtime and Node node:sqlite rather than importing another agent framework. No third-party source code, model, dependency, native runtime, or external service was copied or invoked for U06. D02/H14 remain card references and source-lock entries, not implementation payloads.

| Input | SHA-256 |
|---|---|
| AGENTS.md | b6ab92bf4c41d1cbc44fede9c152614b38bc24e5de8c293a55db258735ef53f4 |
| planning/Xiadie_V2_v1.1/tasks/P02-U06.md | cb443521f7ff3c69a145da425c921610bb406e066640b27a3dce95cb2fb53ff4 |
| docs/sources.lock.json | 009bed3ecc89b12602824ea5d136682d0373e11f3d066e6c2a860cb48afce02e |
| packages/contracts/src/events.ts (U03) | c2a7d013164b1c3e5e6c27748a3b06ef1856cf22346acd11e356c191718500ee |
| packages/storage/events/src/index.ts (accepted U05) | 04f4ecc5f54122dbfa14eff2de982cb3f81967f6d41b205d1694d24127eb9545 |
| packages/adapters/zcode/src/transcript.ts | 73fcaf64d5932fc15ea7c24d47f103891807ca96015c2ff81fc79ada8f4f3174 |
| packages/application/turn-projection.ts | 2fc3f675856588b2ae8e6e3eb668f913b43bc9acb892a066b7e59a9e4e375292 |

The U05 acceptance record is evidence/P02-U05/20261003-01/acceptance.json (SHA-256 8f1f28f4a0b71768cec6300d4e0e554f0a51c26b08c8031cf01d72eca89bc357). No dependency was installed.
