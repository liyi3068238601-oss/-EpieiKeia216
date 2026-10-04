# Xiadie stage execution

The authoritative planning baseline is `planning/Xiadie_V2_v1.1/`, extracted from the original v1.1 archive. Keep this planning copy unchanged. The other archive is historical reference, not an execution baseline.

P01/G01 is accepted and frozen as the historical 0.1.0 baseline. The user's active goal explicitly authorizes completing P03 and an ordinary backup to the supplied GitHub repository. P02 mature SQLite remediation and fresh independent G02 acceptance are complete. P03 has entered from that accepted baseline; finish all ten original P03 units in dependency order, independent integration and G03. Do not enter P04 automatically or create a public release. Keep P00/P01 evidence and historical P02 attempts unchanged. Read current cards, prerequisite evidence and relevant sources. Product implementation requires accepted research and isolated experiments; implement the smallest verified gap.

Preserve existing projects, production runtime profiles, credentials, and user data. References are read-only; experiments use independent data roots. Do not print secrets or store them in evidence or Git.

Record actual commands, cwd, exit codes, source commits, hashes, failures, limitations, and rollback. Distinguish mock, real runtime, real model, and Windows package evidence. `NOT_RUN` is not a pass.

Keep execution status separately from the immutable plan. Authors submit `ready_for_review`; independent reviewers verify exact artifacts or commits before acceptance. Respect task dependencies and one writer per scope.

The user requires startup ports to remain separate from the installed ZCode. Bind experiment services to loopback with OS-allocated free ports; record them and check existing listeners before starting. Desktop experiments must set `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` and use dynamic inspector/CDP ports instead of native fixed 9229. Never stop or reconfigure the installed ZCode to free a port.
