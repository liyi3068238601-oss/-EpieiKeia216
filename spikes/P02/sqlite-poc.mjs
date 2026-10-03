import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, backup } from 'node:sqlite';

const SCRIPT = fileURLToPath(import.meta.url);
const WT = 'E:\\Xiadie\\Xiadie\\.runtime\\P02\\worktrees\\u02';
const PROJECT = 'E:\\Xiadie\\Xiadie';
const NODE = 'E:\\Xiadie\\Xiadie\\.runtime\\P01\\desktop-build-evidence\\toolchain\\node-v24.14.0-win-x64\\node.exe';
const OUT = path.join(PROJECT, '.runtime', 'P02', 'experiments', 'u02', 'sqlite');
const WORKER = path.join(WT, 'spikes', 'P02', 'sqlite-worker.mjs');
const CURRENT_SCHEMA = 2;
const BUSY_LIMIT_MS = 180;
let runDir;
const cases = [];
const failed = [];

const hash = (v) => createHash('sha256').update(v).digest('hex');
const errInfo = (e) => ({ name: e?.name, message: String(e?.message ?? e), code: e?.code, errcode: e?.errcode, errstr: e?.errstr, busyAttempts: e?.busyAttempts, busyWaitMs: e?.busyWaitMs });
const scalar = (db, sql) => Object.values(db.prepare(sql).get() ?? {})[0];
const counts = (db) => Object.fromEntries(['events','origins','receipts'].map((t) => [t, Number(scalar(db, `SELECT count(*) FROM ${t}`))]));
const integrity = (db) => { const value = scalar(db, 'PRAGMA integrity_check'); assert.equal(value, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); return value; };
const stateHash = (db) => hash(JSON.stringify(db.prepare(`SELECT e.id,e.source_id,e.source_event_id,e.canonical_hash,e.payload_json,o.event_id AS origin_event_id,r.event_id AS receipt_event_id,r.canonical_hash AS receipt_hash FROM events e JOIN origins o USING(source_id,source_event_id) JOIN receipts r USING(source_id,source_event_id) ORDER BY e.source_id,e.source_event_id`).all()));

function canonical(v) {
  if (v === null || ['string','boolean'].includes(typeof v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  throw new TypeError(`Unsupported canonical value: ${typeof v}`);
}
export function makeRecord(sourceId, sourceEventId, payload) {
  const payloadJson = JSON.stringify(canonical(payload));
  return { sourceId, sourceEventId, payloadJson, canonicalHash: hash(payloadJson), eventId: hash(`${sourceId}\0${sourceEventId}`).slice(0,32) };
}
export function insertFactSet(db, r) {
  db.prepare('INSERT INTO events(id,source_id,source_event_id,canonical_hash,payload_json) VALUES(?,?,?,?,?)').run(r.eventId,r.sourceId,r.sourceEventId,r.canonicalHash,r.payloadJson);
  db.prepare('INSERT INTO origins(source_id,source_event_id,event_id) VALUES(?,?,?)').run(r.sourceId,r.sourceEventId,r.eventId);
  db.prepare('INSERT INTO receipts(source_id,source_event_id,event_id,canonical_hash) VALUES(?,?,?,?)').run(r.sourceId,r.sourceEventId,r.eventId,r.canonicalHash);
}
function open(dbPath, readOnly = false) { return new DatabaseSync(dbPath, { readOnly, timeout: 0 }); }
function schema(db, version = 1) {
  db.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_event_id TEXT NOT NULL,canonical_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(source_id,source_event_id));
CREATE TABLE origins(source_id TEXT NOT NULL,source_event_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),PRIMARY KEY(source_id,source_event_id));
CREATE TABLE receipts(source_id TEXT NOT NULL,source_event_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),canonical_hash TEXT NOT NULL,PRIMARY KEY(source_id,source_event_id));
PRAGMA user_version=${version};`);
}
function configure(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  const journal = String(scalar(db,'PRAGMA journal_mode=WAL')).toLowerCase();
  db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
  const result = { journal, foreignKeys:Number(scalar(db,'PRAGMA foreign_keys')), synchronous:Number(scalar(db,'PRAGMA synchronous')), busyTimeout:Number(scalar(db,'PRAGMA busy_timeout')) };
  assert.deepEqual(result,{journal:'wal',foreignKeys:1,synchronous:2,busyTimeout:0});
  return result;
}
function newEventDb(file) { const db=open(file); configure(db); schema(db); return db; }
function boundedBegin(db, limit = BUSY_LIMIT_MS) {
  const start=performance.now(), deadline=start+limit; let delay=10, attempts=0;
  for (;;) { attempts++; try { db.exec('BEGIN IMMEDIATE'); return { attempts, waitedMs:Math.round(performance.now()-start) }; }
    catch(e) { if (((Number(e.errcode)||0)&255)!==5) throw e; const remaining=deadline-performance.now(); if(remaining<=0){e.busyAttempts=attempts;e.busyWaitMs=Math.round(performance.now()-start);throw e;} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(1,Math.min(delay,Math.ceil(remaining)))); delay=Math.min(delay*2,40); }
  }
}
function save(db,r) {
  const lock=boundedBegin(db);
  try {
    const old=db.prepare('SELECT event_id,canonical_hash FROM receipts WHERE source_id=? AND source_event_id=?').get(r.sourceId,r.sourceEventId);
    if(old) { if(old.canonical_hash!==r.canonicalHash){db.exec('ROLLBACK');return {kind:'conflict',oldHash:old.canonical_hash,newHash:r.canonicalHash,lock};} db.exec('COMMIT');return {kind:'duplicate',lock}; }
    insertFactSet(db,r);db.exec('COMMIT');return {kind:'inserted',lock};
  } catch(e) { if(db.isTransaction)try{db.exec('ROLLBACK')}catch{};throw e; }
}
function createLegacy(file,version=1) { const db=open(file);db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE legacy(id TEXT PRIMARY KEY,payload TEXT NOT NULL); INSERT INTO legacy VALUES('a','before'); PRAGMA user_version=${version};`);db.close(); }
function preflight(file) { const db=new DatabaseSync(file,{readOnly:true,timeout:100});try{const version=Number(scalar(db,'PRAGMA user_version'));if(version>CURRENT_SCHEMA){const e=new Error(`FUTURE_SCHEMA:${version}>${CURRENT_SCHEMA}`);e.code='FUTURE_SCHEMA';throw e;}return version;}finally{db.close();} }
async function backupNoClobber(source,file) {
  if(fs.existsSync(file)){const e=new Error('BACKUP_TARGET_EXISTS');e.code='BACKUP_TARGET_EXISTS';throw e;}
  const temp=`${file}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try { const pages=await backup(source,temp,{rate:8});const check=new DatabaseSync(temp,{readOnly:true});try{integrity(check);}finally{check.close();}
    fs.linkSync(temp,file);fs.unlinkSync(temp);return {pages,publish:'same-volume hardlink, no-clobber'};
  } catch(e) { if(fs.existsSync(temp))try{fs.unlinkSync(temp)}catch{};throw e; }
}
async function migrate(file,backupFile,{fail=false}={}) {
  const version=preflight(file);if(version>=CURRENT_SCHEMA)return {version,migrated:false};
  const src=new DatabaseSync(file,{readOnly:true,timeout:100});let backed;try{backed=await backupNoClobber(src,backupFile)}finally{src.close();}
  const db=open(file);try{configure(db);const lock=boundedBegin(db);const lockedVersion=Number(scalar(db,'PRAGMA user_version'));if(lockedVersion>CURRENT_SCHEMA)throw Object.assign(new Error('FUTURE_SCHEMA_UNDER_LOCK'),{code:'FUTURE_SCHEMA'});if(lockedVersion!==version)throw Object.assign(new Error('SCHEMA_CHANGED_DURING_BACKUP'),{code:'SCHEMA_CHANGED_DURING_BACKUP'});
    db.exec("ALTER TABLE legacy ADD COLUMN canonical_hash TEXT NOT NULL DEFAULT 'legacy'; INSERT INTO legacy(id,payload) VALUES('b','after');");if(fail)db.exec("INSERT INTO legacy(id,payload) VALUES('a','duplicate')");db.exec(`PRAGMA user_version=${CURRENT_SCHEMA}; COMMIT`);return {version,backed,lock,migrated:true};
  }catch(e){if(db.isTransaction)try{db.exec('ROLLBACK')}catch{};throw e;}finally{db.close();}
}
async function scenario(name,fn){const dir=path.join(runDir,name);fs.mkdirSync(dir);const start=performance.now();try{const details=await fn(dir);const row={name,status:'PASS',elapsedMs:Math.round(performance.now()-start),details};cases.push(row);console.log(`PASS ${name} ${JSON.stringify(details)}`);}catch(e){const row={name,status:'FAIL',elapsedMs:Math.round(performance.now()-start),error:errInfo(e)};cases.push(row);failed.push(row);console.error(`FAIL ${name} ${JSON.stringify(row.error)}`);}}
function spawnWorker(mode,dbPath,r,effect='') {
  const child=spawn(NODE,[WORKER,mode,dbPath,JSON.stringify(r),effect],{cwd:WT,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let out='',err='';child.stdout.setEncoding('utf8').on('data',x=>out=(out+x).slice(-2000));child.stderr.setEncoding('utf8').on('data',x=>err=(err+x).slice(-2000));
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  return {child,out:()=>out,err:()=>err,exit};
}
function stage(child,name,ms=6000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`worker timeout waiting ${name}`)),ms);const msg=m=>{if(m?.stage!==name)return;clearTimeout(timer);child.off('message',msg);resolve(m)};child.on('message',msg);child.once('exit',(c,s)=>{clearTimeout(timer);child.off('message',msg);reject(new Error(`worker exited early ${c}/${s}`))})})}
async function killOwned(child){assert(child.pid&&child.pid!==process.pid);const sent=child.kill('SIGKILL');assert(sent);let timer;const gone=await Promise.race([new Promise(r=>child.once('exit',(c,s)=>r({code:c,signal:s}))),new Promise((_,j)=>{timer=setTimeout(()=>j(new Error('owned child did not exit within 4s')),4000)})]);clearTimeout(timer);return {pid:child.pid,exitCode:gone.code,exitSignal:gone.signal,signalRequested:'SIGKILL'};}
function filesFor(file){return [file,`${file}-wal`,`${file}-shm`].filter(fs.existsSync).map(p=>({name:path.basename(p),sha256:hash(fs.readFileSync(p)),bytes:fs.statSync(p).size}));}
async function cleanupWorker(run){
  const child=run.child;if(child.exitCode!==null||child.signalCode!==null)return;
  assert(child.pid&&child.pid!==process.pid,'cleanup may signal only its owned child PID');child.kill('SIGKILL');let timer;
  try{await Promise.race([run.exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`owned child ${child.pid} did not exit during cleanup`)),4000)})])}finally{clearTimeout(timer)}
}
function rowsHash(db,sql='SELECT id,payload FROM legacy ORDER BY id'){return hash(JSON.stringify(db.prepare(sql).all()));}
async function runScenarios(){
  const record=makeRecord('runtime-A','evt-001',{role:'user',text:'hello',meta:{z:2,a:1}});

  await scenario('identity-transaction-and-pragmas',async dir=>{
    const file=path.join(dir,'facts.sqlite'),db=newEventDb(file);
    try{
      const cfg={journal:String(scalar(db,'PRAGMA journal_mode')).toLowerCase(),foreignKeys:Number(scalar(db,'PRAGMA foreign_keys')),synchronous:Number(scalar(db,'PRAGMA synchronous')),busyTimeout:Number(scalar(db,'PRAGMA busy_timeout'))};
      assert.deepEqual(cfg,{journal:'wal',foreignKeys:1,synchronous:2,busyTimeout:0});
      let fk;try{db.prepare('INSERT INTO origins VALUES(?,?,?)').run('bad','orphan','missing')}catch(e){fk=e}assert(fk&&((Number(fk.errcode)&255)===19));
      const first=save(db,record),same=makeRecord('runtime-A','evt-001',{meta:{a:1,z:2},text:'hello',role:'user'}),replay=save(db,same);
      assert.equal(same.canonicalHash,record.canonicalHash);assert.equal(first.kind,'inserted');assert.equal(replay.kind,'duplicate');
      const before={counts:counts(db),hash:stateHash(db)},conflict=save(db,makeRecord('runtime-A','evt-001',{text:'changed'}));
      assert.equal(conflict.kind,'conflict');assert.deepEqual({counts:counts(db),hash:stateHash(db)},before);assert.deepEqual(counts(db),{events:1,origins:1,receipts:1});
      return {pragmas:cfg,foreignKeyRejectErrcode:fk.errcode,first:first.kind,sameCanonicalReplay:replay.kind,differentHashReplay:conflict.kind,rows:counts(db),stateHash:stateHash(db),integrity:integrity(db)};
    }finally{db.close()}
  });

  await scenario('kill-before-commit-all-or-none',async dir=>{
    const file=path.join(dir,'facts.sqlite'),db=newEventDb(file);db.close();const run=spawnWorker('precommit',file,record);let killed;
    try{const message=await stage(run.child,'prepared');assert.equal(message.inTransaction,true);killed=await killOwned(run.child);const check=open(file,true);try{assert.deepEqual(counts(check),{events:0,origins:0,receipts:0});return {childPid:message.pid,...killed,workerStdout:run.out(),workerStderr:run.err(),rowsAfterKill:counts(check),integrity:integrity(check)};}finally{check.close()}}
    finally{await cleanupWorker(run)}
  });

  await scenario('commit-before-ack-lost-ack-receipt-recheck',async dir=>{
    const file=path.join(dir,'facts.sqlite'),db=newEventDb(file);db.close();const run=spawnWorker('postcommit',file,record);let killed;
    try{const message=await stage(run.child,'committed');assert.equal(message.inTransaction,false);killed=await killOwned(run.child);const check=open(file);try{const before={counts:counts(check),hash:stateHash(check)},retry=save(check,record);assert.equal(retry.kind,'duplicate');assert.deepEqual({counts:counts(check),hash:stateHash(check)},before);return {childPid:message.pid,...killed,ackObserved:false,retryAfterLostAck:retry.kind,rows:counts(check),stateHash:stateHash(check),integrity:integrity(check)};}finally{check.close()}}
    finally{await cleanupWorker(run)}
  });

  await scenario('synthetic-file-effect-before-receipt-unknown-no-replay',async dir=>{
    const file=path.join(dir,'facts.sqlite'),effect=path.join(dir,'mock-external-effect.json'),db=newEventDb(file);db.close();const run=spawnWorker('external-effect',file,record,effect);let killed;
    try{const message=await stage(run.child,'effect-applied');killed=await killOwned(run.child);const check=open(file,true);try{const receipt=check.prepare('SELECT 1 AS yes FROM receipts WHERE source_id=? AND source_event_id=?').get(record.sourceId,record.sourceEventId);const effectHash=hash(fs.readFileSync(effect));assert.equal(receipt,undefined);const recovery={state:'unknown-effect-may-have-happened',action:'manual-reconciliation-required',autoReplay:false,effectHash};assert.equal(hash(fs.readFileSync(effect)),effectHash);return {childPid:message.pid,...killed,effect:'mock local file only; no service',receiptExists:Boolean(receipt),recovery,rows:counts(check)};}finally{check.close()}}
    finally{await cleanupWorker(run)}
  });

  await scenario('sqlite-busy-full-readonly',async dir=>{
    const busyFile=path.join(dir,'busy.sqlite'),setup=newEventDb(busyFile);setup.close();const owner=open(busyFile),contender=open(busyFile);let busyInfo;
    try{owner.exec('PRAGMA busy_timeout=0');contender.exec('PRAGMA busy_timeout=0');owner.exec('BEGIN IMMEDIATE');const t=performance.now();let err;try{boundedBegin(contender,BUSY_LIMIT_MS)}catch(e){err=e}const elapsed=Math.round(performance.now()-t);assert(err&&((Number(err.errcode)&255)===5));assert(elapsed>=BUSY_LIMIT_MS-25&&elapsed<2500);owner.exec('ROLLBACK');const afterRelease=boundedBegin(contender);assert(contender.isTransaction);contender.exec('ROLLBACK');busyInfo={error:errInfo(err),elapsedMs:elapsed,limitMs:BUSY_LIMIT_MS,acquiredAfterRelease:afterRelease};}
    finally{if(owner.isTransaction)owner.exec('ROLLBACK');if(contender.isTransaction)contender.exec('ROLLBACK');owner.close();contender.close()}
    const fullFile=path.join(dir,'full.sqlite'),full=open(fullFile);let fullErr,inserted=0;
    try{full.exec('PRAGMA page_size=4096; CREATE TABLE limited(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); INSERT INTO limited(payload) VALUES(\'base\')');const pages=Number(scalar(full,'PRAGMA page_count')),max=pages+1,effective=Number(scalar(full,`PRAGMA max_page_count=${max}`));assert(effective<=max);full.exec('BEGIN IMMEDIATE');try{for(let i=0;i<100;i++){full.prepare('INSERT INTO limited(payload) VALUES(?)').run(`${i}:${'x'.repeat(5000)}`);inserted++}}catch(e){fullErr=e}assert(fullErr&&((Number(fullErr.errcode)&255)===13));if(full.isTransaction)full.exec('ROLLBACK');assert.equal(Number(scalar(full,'SELECT count(*) FROM limited')),1);integrity(full);busyInfo.full={pageCount:pages,maxPageCount:effective,insertedBeforeFull:inserted,error:errInfo(fullErr),physicalDiskFill:false};}finally{if(full.isTransaction)full.exec('ROLLBACK');full.close()}
    const roFile=path.join(dir,'readonly.sqlite'),rw=newEventDb(roFile);save(rw,makeRecord('ro','one',{v:1}));rw.close();const ro=open(roFile,true);
    try{let roErr;try{ro.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('x','ro','two','h','{}')}catch(e){roErr=e}assert(roErr&&((Number(roErr.errcode)&255)===8));assert.equal(counts(ro).events,1);busyInfo.readonly={mode:'DatabaseSync readOnly:true',error:errInfo(roErr),rows:counts(ro),filesystemAclChanged:false,integrity:integrity(ro)};}finally{ro.close()}
    return busyInfo;
  });
  await scenario('active-wal-backup-restore-and-main-file-negative-control',async dir=>{
    const file=path.join(dir,'source.sqlite'),snap=path.join(dir,'snapshot.sqlite'),restore=path.join(dir,'restore.sqlite'),mainOnly=path.join(dir,'main-only.sqlite');
    const source=newEventDb(file);let pending;
    try{
      source.exec('PRAGMA wal_checkpoint(TRUNCATE)');source.exec('PRAGMA wal_autocheckpoint=0');
      save(source,makeRecord('wal-source','committed',{value:'in WAL'}));const committedHash=stateHash(source),wal=`${file}-wal`,walBefore=fs.statSync(wal).size;assert(walBefore>0);
      pending=open(file);pending.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');insertFactSet(pending,makeRecord('wal-source','uncommitted',{value:'not visible'}));
      const observer=open(file,true);try{assert.equal(counts(observer).events,1)}finally{observer.close()}
      const progress=[];const pages=await backup(source,snap,{rate:1,progress:p=>{if(progress.length<64)progress.push(p)}});
      const snapshot=open(snap,true);let snapCounts,snapHash;
      try{integrity(snapshot);snapCounts=counts(snapshot);snapHash=stateHash(snapshot);assert.deepEqual(snapCounts,{events:1,origins:1,receipts:1});assert.equal(snapHash,committedHash);assert.equal(Number(scalar(snapshot,"SELECT count(*) FROM events WHERE source_event_id='uncommitted'")),0)}finally{snapshot.close()}
      fs.copyFileSync(file,mainOnly);const negative=open(mainOnly,true);let negativeRows,negativeIntegrity;
      try{negativeRows=Number(scalar(negative,'SELECT count(*) FROM events'));negativeIntegrity=integrity(negative);assert.equal(negativeRows,0,'copying only main db must miss committed WAL row')}finally{negative.close()}
      const snapDb=open(snap,true);try{await backup(snapDb,restore,{rate:1})}finally{snapDb.close()}
      const restored=open(restore,true);try{integrity(restored);assert.equal(stateHash(restored),committedHash);assert.deepEqual(counts(restored),snapCounts);
        return {walBytesBeforeBackup:walBefore,walBytesAfterBackup:fs.statSync(wal).size,onlineBackupPages:pages,progressSamples:progress.length,committedHash,snapshotHash:snapHash,restoredHash:stateHash(restored),restoredCounts:counts(restored),mainOnlyNegativeControlRows:negativeRows,mainOnlyIntegrity:negativeIntegrity,otherConnectionUncommittedDuringBackup:true,integrity:integrity(restored)};
      }finally{restored.close()}
    }finally{if(pending?.isTransaction)pending.exec('ROLLBACK');pending?.close();source.close()}
  });

  await scenario('migration-prebackup-success-failure-restore',async dir=>{
    const file=path.join(dir,'success.sqlite'),backupFile=path.join(dir,'pre-migration.sqlite'),restore=path.join(dir,'fresh-restore.sqlite');createLegacy(file,1);
    const before=open(file,true);const beforeHash=rowsHash(before);before.close();const outcome=await migrate(file,backupFile);
    const migrated=open(file,true);try{assert.equal(Number(scalar(migrated,'PRAGMA user_version')),CURRENT_SCHEMA);assert(migrated.prepare('PRAGMA table_info(legacy)').all().some(r=>r.name==='canonical_hash'));
      const snapshot=open(backupFile,true);try{assert.equal(Number(scalar(snapshot,'PRAGMA user_version')),1);assert.equal(rowsHash(snapshot),beforeHash)}finally{snapshot.close()}
      const snap=open(backupFile,true);try{await backup(snap,restore,{rate:1})}finally{snap.close()}
      const fresh=open(restore,true);try{integrity(fresh);assert.equal(Number(scalar(fresh,'PRAGMA user_version')),1);assert.equal(rowsHash(fresh),beforeHash);return {preflightVersion:outcome.version,backupPages:outcome.backed.pages,publish:outcome.backed.publish,sourceVersion:Number(scalar(migrated,'PRAGMA user_version')),restoreVersion:Number(scalar(fresh,'PRAGMA user_version')),beforeHash,restoreHash:rowsHash(fresh),integrity:integrity(fresh)}}finally{fresh.close()}
    }finally{migrated.close()}
  });

  await scenario('migration-failure-rollback-and-backup-recovery',async dir=>{
    const file=path.join(dir,'source.sqlite'),backupFile=path.join(dir,'pre-migration.sqlite'),restore=path.join(dir,'fresh-restore.sqlite');createLegacy(file,1);
    const before=open(file,true),beforeHash=rowsHash(before);before.close();let error;try{await migrate(file,backupFile,{fail:true})}catch(e){error=e}assert(error&&((Number(error.errcode)&255)===19));
    const after=open(file,true);try{assert.equal(Number(scalar(after,'PRAGMA user_version')),1);assert(!after.prepare('PRAGMA table_info(legacy)').all().some(r=>r.name==='canonical_hash'));assert.equal(rowsHash(after),beforeHash)}finally{after.close()}
    const snap=open(backupFile,true);try{await backup(snap,restore,{rate:1})}finally{snap.close()}
    const fresh=open(restore,true);try{integrity(fresh);assert.equal(Number(scalar(fresh,'PRAGMA user_version')),1);assert.equal(rowsHash(fresh),beforeHash);return {observedMigrationError:errInfo(error),sourceRolledBack:true,backupUsed:true,beforeHash,restoreHash:rowsHash(fresh),integrity:integrity(fresh)}}finally{fresh.close()}
  });

  await scenario('existing-backup-target-and-backup-error-block-migration',async dir=>{
    const file=path.join(dir,'source.sqlite'),existing=path.join(dir,'existing-backup.sqlite');createLegacy(file,1);fs.writeFileSync(existing,'preserve-good-backup\n',{flag:'wx'});const oldHash=hash(fs.readFileSync(existing));let existingError;try{await migrate(file,existing)}catch(e){existingError=e}assert.equal(existingError?.code,'BACKUP_TARGET_EXISTS');assert.equal(hash(fs.readFileSync(existing)),oldHash);
    const blockedParent=path.join(dir,'regular-file-parent');fs.writeFileSync(blockedParent,'not a directory');let backupError;try{await migrate(file,path.join(blockedParent,'backup.sqlite'))}catch(e){backupError=e}assert(backupError,'invalid backup destination must fail');
    const check=open(file,true);try{assert.equal(Number(scalar(check,'PRAGMA user_version')),1);assert(!check.prepare('PRAGMA table_info(legacy)').all().some(r=>r.name==='canonical_hash'));return {existingTargetError:errInfo(existingError),existingTargetHashBefore:oldHash,existingTargetHashAfter:hash(fs.readFileSync(existing)),backupApiError:errInfo(backupError),migrationStarted:false,sourceVersion:Number(scalar(check,'PRAGMA user_version')),sourceRowsHash:rowsHash(check)}}finally{check.close()}
  });

  await scenario('future-schema-readonly-preflight-before-write',async dir=>{
    const file=path.join(dir,'future.sqlite'),backupFile=path.join(dir,'must-not-exist.sqlite');createLegacy(file,99);const beforeHash=hash(fs.readFileSync(file)),beforeFiles=filesFor(file);let error;try{await migrate(file,backupFile)}catch(e){error=e}assert.equal(error?.code,'FUTURE_SCHEMA');assert.equal(hash(fs.readFileSync(file)),beforeHash);assert.deepEqual(filesFor(file),beforeFiles);assert(!fs.existsSync(backupFile));const check=open(file,true);try{assert.equal(Number(scalar(check,'PRAGMA user_version')),99);return {error:errInfo(error),fileHashBefore:beforeHash,fileHashAfter:hash(fs.readFileSync(file)),sidecarsBefore:beforeFiles,sidecarsAfter:filesFor(file),backupCreated:false,walOrDdlStarted:false,version:Number(scalar(check,'PRAGMA user_version'))}}finally{check.close()}
  });
}

async function main(){
  assert.equal(process.execPath.toLowerCase(),NODE.toLowerCase());assert.equal(process.versions.node,'24.14.0');assert.equal(typeof backup,'function');
  fs.mkdirSync(OUT,{recursive:true});runDir=path.join(OUT,`run-${new Date().toISOString().replaceAll(':','').replaceAll('.','-')}-${randomBytes(4).toString('hex')}`);fs.mkdirSync(runDir);
  await runScenarios();
  const summary={task:'P02-U02 isolated node:sqlite spike',status:failed.length?'failed':'ready_for_review',baseline:{worktree:WT,branch:'p02-u02',commit:'e809d5c7e9969cbf2f5efd68df326e115cf6f1e6',node:process.version,sqlite:process.versions.sqlite,moduleAbi:process.versions.modules,napi:process.versions.napi,cwd:process.cwd(),networkUsed:false,dependenciesInstalled:false,productionDataUsed:false},outputRoot:OUT,runDir,scenarioCount:cases.length,passed:cases.filter(c=>c.status==='PASS').length,failed:failed.length,cases};
  fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(`SUMMARY ${JSON.stringify(summary)}`);if(failed.length)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(SCRIPT))main().catch(e=>{console.error(`FATAL ${JSON.stringify(errInfo(e))}`);process.exitCode=1});