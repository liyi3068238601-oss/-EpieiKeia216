import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [repo,baseline,head,manifestPath,reportPath]=process.argv.slice(2);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
assert.equal(manifest.task_id,'P01-U08'); assert.equal(manifest.baseline_commit,baseline); assert.equal(manifest.manifest_excludes_itself,true);
const changed=execFileSync('git',['-C',repo,'diff','--name-only',`${baseline}..${head}`],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean).sort();
const self=path.relative(repo,manifestPath).replaceAll('\\','/');
const changedWithoutManifest=changed.filter(x=>x!==self).sort();
const paths=manifest.files.map(x=>x.path).sort();
const rows=[], mismatches=[];
for(const item of manifest.files){
  const bytes=fs.readFileSync(path.join(repo,...item.path.split('/')));
  const diskBytes=bytes.length,diskSha=sha(bytes);
  const commitBlob=execFileSync('git',['-C',repo,'rev-parse',`${head}:${item.path}`],{encoding:'utf8'}).trim();
  const disk= {bytes:diskBytes,sha256:diskSha};
  const ok=diskBytes===item.bytes&&diskSha===item.sha256&&commitBlob===item.git_blob;
  if(!ok)mismatches.push({path:item.path,expected:{bytes:item.bytes,sha256:item.sha256,git_blob:item.git_blob},actual:{...disk,git_blob:commitBlob}});
  rows.push({path:item.path,ok});
}
const report={author_commit:head,baseline_commit:baseline,manifest_path:path.resolve(manifestPath),manifest_bytes:fs.statSync(manifestPath).size,manifest_sha256:sha(fs.readFileSync(manifestPath)),manifest_entries:manifest.files.length,changed_paths:changed.length,manifest_excludes_itself:true,changed_path_set_matches:JSON.stringify(changedWithoutManifest)===JSON.stringify(paths),disk_git_mismatches:mismatches};
assert.equal(report.changed_path_set_matches,true,'Manifest paths do not cover exact commit diff');
assert.deepEqual(mismatches,[],'Manifest bytes/hash/blob mismatch');
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
