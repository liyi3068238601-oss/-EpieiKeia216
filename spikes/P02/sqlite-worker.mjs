import { DatabaseSync } from 'node:sqlite';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { insertFactSet } from './sqlite-poc.mjs';
const [mode, dbPath, json, effectPath] = process.argv.slice(2);
const record = JSON.parse(json);
const pid = process.pid;
let db;
function send(stage, extra={}) { if (!process.send) throw new Error('IPC required'); process.send({stage,pid,...extra}); }
function command(expected,timeout=12000) { return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`parent command timeout ${expected}`)),timeout);const onMessage=m=>{if(m?.command!==expected)return;clearTimeout(timer);process.off('message',onMessage);resolve(m)};process.on('message',onMessage);}); }
async function run(){
  if(!mode||!dbPath||!record?.sourceId||!record?.sourceEventId)throw new Error('invalid worker args');
  db=new DatabaseSync(dbPath,{timeout:0});db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  if(mode==='precommit'){
    db.exec('BEGIN IMMEDIATE');insertFactSet(db,record);send('prepared',{inTransaction:db.isTransaction});await command('resume');db.exec('COMMIT');send('committed');return;
  }
  if(mode==='postcommit'){
    db.exec('BEGIN IMMEDIATE');insertFactSet(db,record);db.exec('COMMIT');send('committed',{inTransaction:db.isTransaction});await command('ack');send('acknowledged');return;
  }
  if(mode==='external-effect'){
    if(!effectPath)throw new Error('effect marker missing');const fd=openSync(effectPath,'wx');try{writeSync(fd,JSON.stringify({action:'synthetic-local-file',actionId:record.sourceEventId,appliedCount:1})+'\n');fsyncSync(fd)}finally{closeSync(fd)}
    send('effect-applied',{effectPath,receiptWritten:false});await command('write-receipt');db.exec('BEGIN IMMEDIATE');insertFactSet(db,record);db.exec('COMMIT');send('receipt-written');return;
  }
  throw new Error(`unknown worker mode ${mode}`);
}
run().catch(e=>{try{send('worker-error',{message:e.message,code:e.code,errcode:e.errcode})}catch{};process.stderr.write(`${e.stack??e}\n`);process.exitCode=1}).finally(()=>{try{db?.close()}catch{}});