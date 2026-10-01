# P00-U08 ZCode memory executor spike

This offline probe exercises the fixed ZCode source pin 29628c9acdb81b703bbd4080c207a0e7ce5e276e. It imports the existing built ToolExecutorImpl, ToolRegistryImpl, PermissionService, Write/Edit/Read handlers, NodeFileSystemAdapter, persistent-agent-memory helpers, child-tool filter, and main project-memory-root helper. The existing tsx ESM loader is required because the built workspace packages resolve some internal .js imports to TypeScript workspace source.

Run from the workspace root on the existing Node 24 installation:

~~~powershell
$node = (Get-Command node.exe).Source
$loader = 'file:///E:/Xiadie/Xiadie/.runtime/P00/zcode/source/node_modules/tsx/dist/esm/index.mjs'
& $node --import $loader 'E:\Xiadie\Xiadie\spikes\zcode-memory\probe.mjs' --root 'E:\Xiadie\Xiadie' --output-dir 'E:\Xiadie\Xiadie\evidence\P00-U08\20261001-01\runs\<unique-run-id>'
~~~

The root parameter can point at the project checkout. If omitted, the script resolves it from its own location. The output directory parameter is required for repeat runs to use a fresh directory; it accepts only a new path under evidence/P00-U08/ or evidence/P00-U11/, allowing U11 to rerun the same probe into its own evidence area. Existing output directories are never overwritten. Every fixture, test repository, user-memory root, and main-memory test root is created only beneath that run directory. The run-local .gitignore excludes generated fixtures and storage, including its nested temporary Git repository, from the project diff.

The fixture creates a synthetic repository and two detached Git worktrees with the same basename. The test also uses git worktree move after creating memory data. Git identity is supplied per commit with command-line -c user.name=... -c user.email=...; the runner does not change global configuration. It records every Git fixture command and verifies that the fixed source checkout is at the pinned commit and clean both before and after the probe.

The test matrix covers user/project/local agent memory roots and tool projection, actual Plan-mode writes to memory Markdown, Plan-mode rejection outside the memory root, explicit Write/Edit disallow rules, read-only child tool filtering followed by executor refusal, same-name project/worktree isolation, move behavior, main Memory workspaceIdentity behavior, and profile-name sanitization collision. All files and values are synthetic. No user data, prompt assets, models, services, installation, or product runtime are used.

The runner prints a compact JSON status and writes full probe-results.json, including observed tool results, file contents, source/runtime entry hashes, scope paths, and Git commands. Keep raw stdout and the verification manifest beside the result in the attempt evidence directory.
