# DSH SDK lifecycle spike

This directory contains an isolated P00-U09 spike against DeepSeek Harness commit `639ed015397290b3745d163aafe02ffee4aa3f84`. The `probe.ts` script imports the existing SDK source through the pinned local `tsx` loader, starts the local source-fallback runtime with an isolated synthetic `DSH_HOME`, and points the DeepSeek Messages provider at a loopback mock. It uses a fake credential and asserts that the provider request advertises no tools. It never reads or invokes production credentials.

Run from the project root in PowerShell, using a new output directory for each attempt:

```powershell
$out = 'E:\Xiadie\Xiadie\evidence\P00-U09\20261001-01\runs\manual-run'
$env:TSX_TSCONFIG_PATH = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\source\packages\sdk\client\tsconfig.json'
node --import 'file:///E:/Xiadie/Xiadie/.runtime/P00/dsh/source/node_modules/tsx/dist/esm/index.mjs' 'E:\Xiadie\Xiadie\spikes\dsh-sdk\probe.ts' --root 'E:\Xiadie\Xiadie' --output-dir $out
$probeExit = $LASTEXITCODE
Remove-Item Env:\TSX_TSCONFIG_PATH -ErrorAction SilentlyContinue
exit $probeExit
```

The script records its structured result as `probe.json`, writes the completed and unknown host-checkpoint examples, preserves fake-runtime case outputs and owned PIDs, and prints one JSON summary line. The evidence attempt also records stdout, stderr, and exit code. Keep the output directory after a run; do not recursively remove generated profiles or process evidence.

The probe covers actual SDK initialization, prompt receipt, idle and assistant text over local SSE; same-ID reopen behavior; duplicate receipt and empty-final fixtures; dirty stdout; slow SSE; shutdown of an EOF/SIGTERM-ignoring direct runtime; detached-helper behavior; and host-owned completed-result checkpoint readback. Same-ID resume, per-prompt cancellation, approval response, crash-consistent checkpoint recovery, and product runtime behavior are not supported by or claimed for this SDK path. Unknown checkpoint state is held without an automatic retry.

`fake-runtime-launcher.mjs` wraps the pinned SDK fake-runtime test fixture and its protocol-fault switches. `spikes/P00/dsh-runtime/disable-tools.cordis.patch.yml` is the existing P00-U02 patch used to remove sensitive tool surfaces from `sdk-minimal`. The Windows Job Object harness files in this directory were authored by the coordinator; their separately reviewed results are linked from the U09 evidence and are not part of the SDK's native protocol.

The target `tests/units/P00-U09.test.ts` maps to the branches actually executed by `probe.ts` and to the coordinator's frozen-probe-under-Job and detached-child Job runs; `evidence/P00-U09/20261001-01/verification.json` binds their results and source hashes. This is a task-to-evidence mapping, not a newly created product test file. No product test framework was introduced for this research spike.
