# Xiadie 0.0.0 research candidate

This small ZIP is a P00 research kit, not an application, Windows installer, or P01 implementation. It contains only this README, `candidate.py`, and `manifest.json`; fixed third-party trees and compiled runtimes stay outside the ZIP.

Run it from a fresh extraction with Python 3.12 and an explicit external project root:

```powershell
python candidate.py --case smoke --external-root <fixed-project-root> --output-dir <fresh-output>
python candidate.py --case no-key --external-root <fixed-project-root> --output-dir <fresh-output>
python candidate.py --case no-dsh --external-root <fixed-project-root> --output-dir <fresh-output>
python candidate.py --case offline --external-root <fixed-project-root> --output-dir <fresh-output>
```

The supported project baseline and every required source, runtime entry, and accepted probe are pinned in `manifest.json`. The candidate refuses to overwrite an output directory and verifies the packaged files and the external files needed for the selected case. The smoke case delegates to the accepted U11 integration runner. The other cases run only its accepted ZCode mock copy; they do not invoke a real model or read global credential files. The synthetic fixture writes a fake `p00-fixture-key` field into its temporary personal config, which is not a user credential.

`no-key` means the local mock path works without a real model credential. Real-model availability, future Settings UI, and native provider authorization are `NOT_RUN`. `no-dsh` checks a deliberately absent DSH entry override, records it as unavailable without launching DSH, then runs the ZCode mock path; it does not preflight the DSH source tree. `offline` performs one real TCP connect attempt to a just-closed `127.0.0.1` port and requires the connection to fail, then records and reads back a small research-only state (`upstream_state=unavailable`, `provider_result=null`, `local_result=mock diagnostic only`). The ZCode mock is an independent local diagnostic, not a native provider fallback. This is a loopback diagnostic, not an OS-wide network sandbox.

All three upstream sources, Node/Python runtimes, and project files are external dependencies. This candidate is a repeatable local evidence bundle, not a portable distribution. No third-party source or binary, role asset, user-profile contents, or real credential is packaged. The manifest records absolute paths to local tool executables; those paths describe this machine's test setup and do not make the ZIP portable. The authoritative asset manifest has `approvedAssets: []`; persona/Life schemas and Live2D assets are `NOT_PRESENT_IN_P00`. Their design contracts remain future work and are not counted as runtime implementation.
