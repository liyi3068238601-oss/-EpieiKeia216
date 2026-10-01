# Native ZCode context seam

Original synthetic P00 fixture. Prerequisite: accepted U06 and the U02 isolated ZCode build. No upstream files, production profiles, character assets or Loop code are modified.

Run from `E:\Xiadie\Xiadie` with the existing Python 3.12 driver:

```powershell
python spikes/zcode-context/probe.py mock
python spikes/zcode-context/probe.py real
```

`real` makes at most one authorized 7877 generation request and first requires matching successful mock source/code/entry bindings. It reads the existing credential only in the Python relay; the native child receives a synthetic key and localhost endpoint. Do not rerun accepted real evidence merely to refresh metadata.

The official plugin layout is `.zcode-plugin/plugin.json` plus `hooks/hooks.json`. Hook processes use argv, native plugin variables, JSON stdin and `hookSpecificOutput.additionalContext`. The independent user audit hook proves user-before-plugin ordering. The synthetic packet changes version before each turn; it is an original test record, not user memory or a product persona.

`host.mjs` calls native `startProcessProviderRegistryRuntime`, `createZCodeApp`, `submitPrompt`, persistence, compact, executor and close. Existing tsx resolves the upstream workspace's source exports alongside compiled bootstrap modules. This is a headless API harness, not a complete CLI startup, UI adapter or Windows distribution. It omits standalone account import, builtin remote refresh and dotenv. The runtime's `plan` alias normalizes to permission mode `build` with `planEnabled=true`; both are asserted.

The persistent mock app executes new / compact / postcompact / failed Read / denied Write, then closes and resumes the same stored session. Permission testing intentionally returns `allow` from PreToolUse and checks that the native Plan denial still wins with memory disabled. This does not establish safety for enabled memory; U08 separately tests that exception and explicit read-only restrictions.

SessionStart and UserPromptSubmit add user-level `<system-reminder>` context before the current request. They preserve the native system prefix, and do not replace its privileged identity. UserPromptSubmit supplies a fresh packet after compact without relying on a second SessionStart. Persona consistency, all-model support, bounded Life budget, OS sandboxing, malicious plugins and product packaging are outside this probe.

Every execution uses a new `.runtime/P00/zcode-context/<run-id>` data/home/temp/fixture root and appends its raw evidence under `evidence/P00-U07/20261001-01/runs/`. Failed runs remain available. No recursive cleanup or production write is performed.
