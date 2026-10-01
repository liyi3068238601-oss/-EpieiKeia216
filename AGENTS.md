# Xiadie stage execution

The authoritative planning baseline is `planning/Xiadie_V2_v1.1/`, extracted from the original v1.1 archive. Keep this planning copy unchanged. The other archive is historical reference, not an execution baseline.

The user has authorized entering P01 after G00 passed. Execute P01 in task-card dependency order, through its independent integration and G01 gate; do not start P02 automatically. Preserve the accepted P00 evidence as a historical baseline. Read the current task card, prerequisite evidence, and relevant sources. Research existing solutions, run isolated experiments, then implement the smallest verified gap. Product implementation requires accepted P01-U01 research and P01-U02 experiments.

Preserve existing projects, production runtime profiles, credentials, and user data. References are read-only; experiments use independent data roots. Do not print secrets or store them in evidence or Git.

Record actual commands, cwd, exit codes, source commits, hashes, failures, limitations, and rollback. Distinguish mock, real runtime, real model, and Windows package evidence. `NOT_RUN` is not a pass.

Keep execution status separately from the immutable plan. Authors submit `ready_for_review`; independent reviewers verify exact artifacts or commits before acceptance. Respect task dependencies and one writer per scope.
