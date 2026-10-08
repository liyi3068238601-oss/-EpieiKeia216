$ErrorActionPreference = 'Stop'
$repo = 'E:\Xiadie\Xiadie'
$worktree = (Get-Location).Path
$native = Join-Path $repo '.runtime\P01\desktop-source'
$prep = Join-Path $repo '.runtime\P03\preparation'
$evidence = Join-Path $worktree 'evidence\P03-U01\20261004-01'
$baseline = (git -C $worktree rev-parse HEAD).Trim()
$branch = (git -C $worktree branch --show-current).Trim()
$nativeHead = (git -C $native rev-parse HEAD).Trim()
$nativeStatus = (git -C $native status --porcelain | Out-String).Trim()
if ($nativeHead -ne '29628c9acdb81b703bbd4080c207a0e7ce5e276e' -or $nativeStatus) { throw 'Pinned Native source checkout is not at expected clean commit.' }

$groups = @(
  [pscustomobject]@{ name='author-worktree'; root=$worktree; prefix=''; files=@(
    'AGENTS.md','planning\Xiadie_V2_v1.1\tasks\P03-U01.md','planning\Xiadie_V2_v1.1\tasks\P03-U02.md','planning\Xiadie_V2_v1.1\templates\handoff.md','docs\sources.lock.json',
    'packages\adapters\zcode\src\host.ts','packages\contracts\src\context.ts','packages\diagnostics\src\index.ts','packages\diagnostics\test\diagnostics.test.mjs','packages\context\src\index.ts','packages\context\test\context.test.mjs','tests\integration\P01\factory.mjs','tests\integration\P01\factory.test.mjs','packages\application\test\native-projection.integration.test.mjs','spikes\zcode-memory\README.md','spikes\zcode-memory\probe.mjs','evidence\P00-U08\20261001-01\result.md','evidence\P00-U08\20261001-01\runs\attempt-03\probe-results.json'
  ) },
  [pscustomobject]@{ name='native-fixed-checkout'; root=$native; prefix='.runtime/P01/desktop-source/'; files=@(
    'LICENSE','package.json','pnpm-workspace.yaml','pnpm-lock.yaml','apps\zcode-cli\package.json','apps\zcode-cli\packages\core\package.json','packages\services\package.json',
    'apps\zcode-cli\packages\core\src\context\sections\memory.ts','apps\zcode-cli\packages\core\src\subagent\persistent-memory.ts','apps\zcode-cli\packages\core\src\memory\index-content.ts','apps\zcode-cli\packages\core\src\subagent\persistent-memory-prompt.ts','apps\zcode-cli\packages\core\src\memory\project-root.ts','apps\zcode-cli\packages\core\src\memory\recall\manifest.ts','apps\zcode-cli\packages\core\src\runtime\methods\context.ts','apps\zcode-cli\packages\core\src\runtime\methods\context-refresh.ts','packages\services\src\memory\memoryService.ts','packages\services\src\memory\projectMemoryStableRead.ts','packages\services\src\paths.ts','packages\services\test\nonCliAcpRetirement.test.ts',
    'apps\zcode-cli\packages\contracts\src\tools\agent.ts','apps\zcode-cli\packages\contracts\src\interfaces\subagent.port.ts','apps\zcode-cli\packages\core\src\tool\handlers\agent.ts','apps\zcode-cli\packages\core\src\subagent\runner.ts','apps\zcode-cli\packages\core\src\runtime-task\registry.ts','apps\zcode-cli\packages\core\src\subagent\completion-notification.ts',
    'apps\zcode-cli\packages\core\src\runtime\agent-runtime.ts','apps\zcode-cli\packages\core\src\runtime\methods\subagent.ts','apps\zcode-cli\packages\core\src\runtime\helpers\tool-allowlist.ts','apps\zcode-cli\packages\core\src\tool\executor\call-runner.ts','apps\zcode-cli\packages\core\src\permission\service.ts','apps\zcode-cli\packages\core\src\tool\executor\permission-flow.ts','apps\zcode-cli\packages\core\src\tool\executor\memory-file-permission.ts','apps\zcode-cli\packages\core\src\tool\handlers\write.ts','apps\zcode-cli\packages\core\src\tool\handlers\edit.ts','apps\zcode-cli\packages\core\src\tool\path-policy.ts','apps\zcode-cli\packages\adapters\src\fs\index.ts','apps\zcode-cli\packages\contracts\src\interfaces\permission.port.ts','apps\zcode-cli\packages\core\src\permission\rule-matching.ts','apps\zcode-cli\packages\core\src\tool\executor\permission-suggestions.ts','apps\zcode-cli\packages\core\src\mcp\index.ts','apps\zcode-cli\packages\core\src\runtime\methods\mcp.ts'
  ) },
  [pscustomobject]@{ name='parser-upstream-checkouts'; root=$prep; prefix='.runtime/P03/preparation/'; files=@(
    'parser-source-review\marked-upstream\package.json','parser-source-review\marked-upstream\LICENSE.md','parser-source-review\marked-upstream\src\marked.ts','parser-source-review\marked-upstream\src\Lexer.ts','parser-source-review\marked-upstream\test\unit\Lexer.test.js','parser-source-review\marked-upstream\test\specs\new\html_comments.md','parser-source-review\marked-upstream\test\specs\new\html_comments.html',
    'parser-source-review\yaml-upstream\package.json','parser-source-review\yaml-upstream\LICENSE','parser-source-review\yaml-upstream\src\public-api.ts','parser-source-review\yaml-upstream\src\parse\parser.ts','parser-source-review\yaml-upstream\src\doc\Document.ts','parser-source-review\yaml-upstream\src\nodes\Alias.ts','parser-source-review\yaml-upstream\tests\doc\anchors.ts','parser-source-review\yaml-upstream\tests\doc\YAML-1.2.spec.ts'
  ) },
  [pscustomobject]@{ name='adr-upstream-checkouts'; root=$prep; prefix='.runtime/P03/preparation/'; files=@(
    'adr-handoff-comparison\sources\madr\package.json','adr-handoff-comparison\sources\madr\README.md','adr-handoff-comparison\sources\madr\LICENSE','adr-handoff-comparison\sources\madr\LICENSE.MIT','adr-handoff-comparison\sources\madr\LICENSE.CC0-1.0','adr-handoff-comparison\sources\madr\template\adr-template.md','adr-handoff-comparison\sources\madr\template\adr-template-minimal.md','adr-handoff-comparison\sources\madr\.github\workflows\lint.yaml','adr-handoff-comparison\sources\madr\.github\workflows\check-links.yaml','adr-handoff-comparison\sources\madr\.github\workflows\pages.yaml',
    'adr-handoff-comparison\sources\adr-tools\README.md','adr-handoff-comparison\sources\adr-tools\INSTALL.md','adr-handoff-comparison\sources\adr-tools\LICENSE.txt','adr-handoff-comparison\sources\adr-tools\Makefile','adr-handoff-comparison\sources\adr-tools\src\adr-new','adr-handoff-comparison\sources\adr-tools\src\template.md','adr-handoff-comparison\sources\adr-tools\tests\project-specific-template.sh'
  ) },
  [pscustomobject]@{ name='preparation-inputs'; root=$prep; prefix='.runtime/P03/preparation/'; files=@(
    'native-source-review.md','root-runtime-memory-seam-notes.md','root-design-notes.md','root-legacy-key-followup.md','parser-source-review\findings.md','parser-source-review\source-manifest.json','adr-handoff-comparison\report.md','adr-handoff-comparison\intake-log.json','adr-handoff-comparison\source-file-manifest.json','relocation-official-notes.md','reviewer-permission-seam\preparation.md','p03-u01-author\PREPARATION.md','environment-prerequisites.json'
  ) }
)
$filesOut = foreach ($group in $groups) {
  foreach ($relative in $group.files) {
    $path = Join-Path $group.root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing bound source: $($group.name)/$relative" }
    $item = Get-Item -LiteralPath $path
    [ordered]@{ group=$group.name; path=($group.prefix + ($relative -replace '\\','/')); bytes=[long]$item.Length; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
  }
}
$parserManifestPath = Join-Path $prep 'parser-source-review\source-manifest.json'
$parser = Get-Content -LiteralPath $parserManifestPath -Raw | ConvertFrom-Json
$adrManifestPath = Join-Path $prep 'adr-handoff-comparison\source-file-manifest.json'
$adr = Get-Content -LiteralPath $adrManifestPath -Raw | ConvertFrom-Json
$intake = Get-Content -LiteralPath (Join-Path $prep 'adr-handoff-comparison\intake-log.json') -Raw | ConvertFrom-Json
$repoSummaries = foreach ($sourceRepo in $adr.repositories) {
  [ordered]@{ name=$sourceRepo.name; url=$sourceRepo.url; pinned_commit=$sourceRepo.pinned_commit; actual_commit=$sourceRepo.actual_commit; clean=$sourceRepo.worktree_clean; files=$sourceRepo.files.Count; checkout_blobs_all_match=(($sourceRepo.files | Where-Object { -not $_.checkout_matches_blob_bytes }).Count -eq 0) }
}
$record = [ordered]@{
  schema='p03-u01-source-manifest/v1'
  task='P03-U01'
  attempt='20261004-01'
  captured_at_utc=(Get-Date).ToUniversalTime().ToString('o')
  author_worktree=[ordered]@{ path=$worktree; branch=$branch; baseline_commit=$baseline }
  native_checkout=[ordered]@{ path='.runtime/P01/desktop-source'; commit=$nativeHead; license='Apache-2.0'; clean=([string]::IsNullOrEmpty($nativeStatus)) }
  preparation_manifests=[ordered]@{
    parser_source_manifest=[ordered]@{ path='.runtime/P03/preparation/parser-source-review/source-manifest.json'; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $parserManifestPath).Hash.ToLowerInvariant(); captured_at=$parser.capturedAt; packages=@($parser.upstream | ForEach-Object { [ordered]@{ name=$_.name; version=$_.tag; commit=$_.commit; tag_object=$_.tagObject; license=$_.license; engines=$_.engines; external_runtime_dependencies=$_.externalRuntimeDependencies; npm_sri=$_.npmSRI } }); installed=@($parser.installedPackages | ForEach-Object { [ordered]@{ name=$_.name; files=$_.fileCount; bytes=$_.totalBytes; inventory_sha256=$_.canonicalInventorySha256 } }) }
    adr_source_manifest=[ordered]@{ path='.runtime/P03/preparation/adr-handoff-comparison/source-file-manifest.json'; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $adrManifestPath).Hash.ToLowerInvariant(); captured_at_utc=$adr.generated_at_utc; repositories=@($repoSummaries) }
    official_intake=[ordered]@{ path='.runtime/P03/preparation/adr-handoff-comparison/intake-log.json'; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $prep 'adr-handoff-comparison\intake-log.json')).Hash.ToLowerInvariant(); searches=@($intake.official_searches); pinned_sources=@($intake.pinned_sources); failed_or_corrected_lookups=@($intake.failed_or_corrected_lookups) }
  }
  read_inputs=$filesOut
  inspected_but_not_executed=[ordered]@{
    tests=@('Native services: packages/services/test/nonCliAcpRetirement.test.ts (contains list/readProjectMemoryFile smoke path)','Native core: no direct project-memory or persistent-memory test path was found in the pinned core package; checked source tree path inventory','marked: test/unit/Lexer.test.js and test/specs/new/html_comments.{md,html}','yaml: tests/doc/anchors.ts and tests/doc/YAML-1.2.spec.ts','adr-tools: tests/project-specific-template.sh and other test paths bound by the upstream file manifest','MADR: CI lint/check-links/pages workflows; no behavior test for the static templates','Xiadie: context, diagnostics, Native factory and P00-U08 source/evidence files listed in read_inputs')
    installs=@('Native package/workspace manifests, lockfile, package export maps and pinned source LICENSE inspected','marked/yaml pinned package metadata, source LICENSE and npm SRI checked in existing parser manifest; no install hook/runtime dependency was reported there','MADR package manifest and template/license source inspected; static use needs no installed tooling','adr-tools INSTALL.md, Makefile and LICENSE.txt inspected; Bash/POSIX setup and content license recorded')
    run_tests='NOT_RUN'
    install_or_build='NOT_RUN'
    model_or_product_runtime='NOT_RUN'
  }
  search_record=[ordered]@{
    date='2026-10-04'
    local_terms=@('memoryCandidates|ContextPacket|preflight|memoryProvider|memoryReader|memory.enabled','workspaceIdentity|project-memory|memoryService|projectMemoryStableRead|persistent-memory|memoryIndexContent','marked Lexer HTML comments; yaml parseDocument errors warnings aliases','MADR 4.0.0 template license; adr-tools pinned template installation tests license; Git worktree move repair common-dir')
    recorded_official_queries=@($intake.official_searches | ForEach-Object { $_.queries })
    direct_official_pages=@('https://git-scm.com/docs/git-worktree','https://git-scm.com/docs/git-rev-parse','https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e','https://github.com/markedjs/marked/tree/244941a19225303f94aa60cb728373dc56e1dadf','https://github.com/eemeli/yaml/tree/ddb21b04cb889722cec8f89dc1b67f19d62d7f7d','https://github.com/adr/madr/tree/2475fe1973f66a12aaf58a91d8fa7b42c0f5ea3d','https://github.com/npryce/adr-tools/tree/b3279baf9be2207d1a4f4bbd608fd0b591c72aee')
    note='Reused the dated pinned-source audits; no broad web search or new checkout was performed for this author pass. Direct official Git documentation and pinned-source pages were opened on 2026-10-04.'
  }
}
$manifestPath = Join-Path $evidence 'source-manifest.json'
$record | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
Write-Output "manifest=$manifestPath sha256=$hash files=$($filesOut.Count) native=$nativeHead"
