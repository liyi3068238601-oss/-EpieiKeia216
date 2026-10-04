# Reviewer audit harness attempts

These were reviewer-script problems, not candidate or product failures.

- The first 663 manifest audit ran while the author was making its requested documentation correction; its `clean` assertion correctly stopped on the concurrent author-tree edit. The clean 36e9d2c manifest audit then passed, but that checkpoint was later superseded.
- The 36e9d2c raw-evidence pointer audit found that `runtime-raw-index.json` named the index and command record without a separator before their filenames. d0952673 corrected both strings. The corrected final audit verifies the referenced files by their paths and declared hashes.
- One d095 script attempt restricted all raw-index originals to `.runtime/P02/experiments`, while three indexed provenance inputs are under `.runtime/P02/preparation`; the reviewer’s scope assertion was too narrow. The next run allowed only `.runtime/P02` and verified each original hash and staged copy.
- The first complete d095 candidate/runtime audit reached the final result assembly and then raised `KeyError: sqlite_version`; the verifier result has `package_version` but the SQLite runtime version comes from the already-validated descriptor. The audit output field was corrected before the final run.

The failed harness output files are retained alongside this note. The exact previous metadata pointer defect is visible in the superseded Git version of `runtime-raw-index.json`, and its corrected source path is covered by the d095 manifest and independent audit.
