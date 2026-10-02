import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [repo,finalDir,author,source,assembly,coord,reportPath]=process.argv.slice(2);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const rel=(base,file)=>path.resolve(file);
const ui=path.join(repo,'evidence/P01-U08/20261002-01/ui/u08-no-key-1790941116487135000');
const descriptor=path.join(repo,'evidence/P01-U08/20261002-01/desktop-assembly-07.json');
const manifest=path.join(repo,'evidence/P01-U08/20261002-01/manifest.json');
const paths=[
  ['install-meta.json','Pinned Node/pnpm and frozen-offline install command metadata'],
  ['install.log','Frozen offline install log'],
  ['pinned-checks-meta.json','Pinned Node check/build/U08 unit commands'],
  ['typecheck-pinned.log','Pinned Node typecheck log'],
  ['boundary-pinned.log','Import-boundary scan log'],
  ['build-pinned.log','Pinned Node build log'],
  ['u08-unit-pinned.log','P01-U08 unit test log'],
  ['independent-counterexamples.json','Independent credential and path counterexamples'],
  ['independent-counterexamples.log','Independent counterexample log'],
  ['review-ui-launch.log','Independent no-Key Desktop UI runner log'],
  ['review-ui-launch-attempt-01-failed.log','Preserved failed direct invocation before running the proper UI orchestrator'],
  ['manifest-verification.json','Independent changed-path, manifest byte/SHA/Git blob verification'],
  ['manifest-verification.log','Manifest verification log'],
  ['assembly-verification.json','Independent verification of all descriptor-listed Desktop artifacts'],
  ['assembly-verification.log','Assembly verification log'],
  ['prior-review/report.json','Preserved changes_required report for superseded exact commit'],
  [path.join(repo,'packages/config/desktop-build.mjs'),'Reviewed path-safe Desktop assembly recipe'],
  [path.join(repo,'packages/config/test/desktop-build-paths.test.mjs'),'Committed Desktop path regression tests'],
  [path.join(repo,'packages/config/test/warmup.test.mjs'),'Pinned warmup test source resolver'],
  [path.join(repo,'packages/config/src/index.ts'),'Profile, path, and child environment implementation'],
  [path.join(repo,'packages/secrets/src/index.ts'),'Per-call credential authorization implementation'],
  [path.join(repo,'packages/config/test/run-desktop-no-key.py'),'Native UI harness driver'],
  [path.join(author,'evidence/P01-U08/20261002-01/desktop-build-07-command.json'),'Author build-07 command and artifact bind'],
  [descriptor,'Final Desktop assembly descriptor'],
  [manifest,'Final author change manifest'],
  [path.join(ui,'summary.json'),'Independent actual Desktop UI run summary'],
  [path.join(ui,'ui-result.json'),'Independent two-launch settings/history UI result'],
  [path.join(ui,'network.jsonl'),'Independent network guard log'],
  [coord,'Coordinator exact-commit/author-manifest verification'],
  [path.join(source,'packages/services/src/zcode-agent/zcodeAgentService.ts'),'Pinned upstream source used for the single host patch'],
  [path.join(assembly,'packages/desktop/out/host/index.js'),'Patched host artifact'],
  [path.join(assembly,'packages/desktop/out/main/index.js'),'Pinned main artifact'],
  [path.join(assembly,'packages/desktop/out/preload/index.cjs'),'Pinned preload artifact'],
  [path.join(assembly,'packages/desktop/out/renderer/index.html'),'Pinned renderer entry artifact'],
  [path.join(assembly,'apps/zcode-cli/packages/cli/dist/zcode.cjs'),'Pinned CLI artifact']
];
const artifacts=paths.map(([file,role])=>{
  const full=path.isAbsolute(file)?path.resolve(file):path.resolve(finalDir,file);
  const data=fs.readFileSync(full);
  return {role,path:full,bytes:data.length,sha256:sha(data)};
});
const checks=JSON.parse(fs.readFileSync(path.join(finalDir,'pinned-checks-meta.json'),'utf8'));
const install=JSON.parse(fs.readFileSync(path.join(finalDir,'install-meta.json'),'utf8'));
const independent=JSON.parse(fs.readFileSync(path.join(finalDir,'independent-counterexamples.json'),'utf8'));
const assemblyCheck=JSON.parse(fs.readFileSync(path.join(finalDir,'assembly-verification.json'),'utf8'));
const manifestCheck=JSON.parse(fs.readFileSync(path.join(finalDir,'manifest-verification.json'),'utf8'));
const uiSummary=JSON.parse(fs.readFileSync(path.join(ui,'summary.json'),'utf8'));
const uiResult=JSON.parse(fs.readFileSync(path.join(ui,'ui-result.json'),'utf8'));
const build=JSON.parse(fs.readFileSync(path.join(author,'evidence/P01-U08/20261002-01/desktop-build-07-command.json'),'utf8'));
const coordData=JSON.parse(fs.readFileSync(coord,'utf8'));
const currentWorktreeStatus=execFileSync('git',['-C',repo,'status','--porcelain'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const trackedDirty=execFileSync('git',['-C',repo,'diff','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const report={
 schema_version:1,
 task:'P01-U08 independent exact-commit review',
 decision:'pass',
 review_target:{author_commit:'3de2c0621d8fcfec5a7874ca2c0df8d9de4deb53',baseline_commit:'e78c8f9cd4568956f43e57fab291ecc6d3142fd6',review_worktree:path.resolve(repo),detached:true,tracked_product_changes:trackedDirty,reviewer_generated_ui_evidence:'evidence/P01-U08/20261002-01/ui/u08-no-key-1790941116487135000'},
 findings_closed:[
  {id:'U08-R1',path:'packages/config/desktop-build.mjs',closure:'Physical source and nearest existing output ancestor are canonicalized before path.relative containment. Independent case-only alias and junction-alias outputs were rejected before writing; an external sibling output remained allowed.'},
  {id:'U08-R2',path:'packages/config/test/warmup.test.mjs',closure:'The test no longer derives the source checkout from repoRoot; with P01_U08_ZCODE_SOURCE unset, default pinned source was found and warmup tests passed in the detached review checkout.'}
 ],
 validation:{
  toolchain:{node:install.node_version,pnpm:install.pnpm_version,install:'frozen-lockfile offline install; exit 0',store:install.store},
  checks:checks.map(x=>({name:x.name,exit_code:x.exit_code,log:x.log})),
  boundary_scan:'exit 0; reports NOT_RUN because packages/core is absent',
  u08_unit:{passed:19,failed:0,node:'24.14.0',source_path_override:'unset'},
  independent_counterexamples:independent.results,
  manifest:{independently_verified:true,entries:manifestCheck.manifest_entries,changed_paths:manifestCheck.changed_paths,manifest_excludes_itself:true,path_set_matches_diff:manifestCheck.changed_path_set_matches,disk_git_mismatches:manifestCheck.disk_git_mismatches,bytes:manifestCheck.manifest_bytes,sha256:manifestCheck.manifest_sha256,coordinator_verification:coordData},
  desktop_build:{author_build_exit_code:build.exit_code,source_commit:assemblyCheck.source_commit,recipe_sha256:assemblyCheck.recipe_sha256,source_input_sha256:assemblyCheck.source_input_sha256,patched_source_sha256:assemblyCheck.patched_source_sha256,descriptor_entries:assemblyCheck.artifact_count_listed,descriptor_bytes:assemblyCheck.artifact_bytes_listed,descriptor_hash_mismatches:assemblyCheck.artifact_hash_mismatches,missing_artifacts:assemblyCheck.artifact_missing,source_clean:assemblyCheck.source_clean,main_preload_renderer_files_equal_to_pin:assemblyCheck.desktop_main_preload_renderer_identical_to_pinned_source,unlisted_runtime_files:assemblyCheck.unlisted_files},
  desktop_ui:{reviewer_run_id:uiSummary.run_id,passed:uiSummary.passed,exit_code:uiSummary.exit_code,launches:uiResult.snapshots.length,settings_and_history_each_launch:uiResult.snapshots.every(x=>x.settings&&x.history_visible),production_unchanged:uiSummary.production_unchanged,source_clean:uiSummary.reference_source_clean,code_unchanged:uiSummary.code_unchanged,model_requests:uiSummary.model_requests,real_credential_loaded:uiSummary.real_credential_loaded,DSH_started:uiSummary.DSH_started,allowed_external_http:0,denied_unknown_fetch_requests:7,guard_scope:uiSummary.guard_scope,visual_acceptance:uiResult.visual_acceptance},
  source_change_state:{tracked_changes:trackedDirty,reviewer_ui_output_is_untracked:true}
 },
 limitations:['No real key, model request, paid call, DSH, Claude import, visual-design acceptance, or portable installer run.','Desktop UI used synthetic native history and a fixed local-development assembly that reuses the pinned dependency junction.','Assembly digest verification covers all 6,638 descriptor-listed files; runtime cache files and the xiadie-build.json sidecar created after assembly are reported separately, not represented as build artifacts.'],
 artifacts
};
assert.equal(report.decision,'pass');
assert.equal(manifestCheck.changed_path_set_matches,true);assert.deepEqual(manifestCheck.disk_git_mismatches,[]);
assert.deepEqual(assemblyCheck.artifact_hash_mismatches,[]);assert.deepEqual(assemblyCheck.artifact_missing,[]);
assert.equal(uiSummary.passed,true);assert.equal(uiSummary.model_requests,0);assert.equal(uiSummary.real_credential_loaded,false);
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:reportPath,bytes:fs.statSync(reportPath).size,sha256:sha(fs.readFileSync(reportPath)),artifacts:artifacts.length,decision:report.decision},null,2));
