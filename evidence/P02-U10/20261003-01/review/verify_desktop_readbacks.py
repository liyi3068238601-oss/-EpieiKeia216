import hashlib, json, pathlib, subprocess, sys
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie')
WT=ROOT/'.runtime/P02/worktrees/u10'
EV=WT/'evidence/P02-U10/20261003-01'
PROOF=EV/'candidate-proof'
NODE=ROOT/'.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
VERIFY=WT/'tests/integration/P02/verify-ledger.mjs'
OUT=ROOT/'.runtime/P02/reviews/u10/ledger-readback'

def ensure(x,msg):
    if not x: raise AssertionError(msg)
def sha(b): return hashlib.sha256(b).hexdigest()
# Bind archived Desktop evidence to retained original run files.
index=json.loads((EV/'candidate-proof-index.json').read_bytes())
ensure(index['schema']=='p02-candidate-proof-archive/v1' and index['task']=='P02-U10','proof index identity mismatch')
archive_bad=[]
for item in index['artifacts']:
    copied=EV/item['path']
    original=pathlib.Path(item['original'])
    if not copied.is_file() or not original.is_file(): archive_bad.append(item['path']); continue
    data=copied.read_bytes()
    if len(data)!=item['bytes'] or sha(data)!=item['sha256'] or data!=original.read_bytes(): archive_bad.append(item['path'])
ensure(len(index['artifacts'])==319,'proof index count mismatch')
ensure(not archive_bad,f'archived evidence copies differ: {archive_bad[:8]}')
OUT.mkdir(parents=True,exist_ok=False)
runs=[('full',6),('degradation',3)]
results=[]
for group,expected_count in runs:
    summary=json.loads((PROOF/f'runs/{group}/summary.json').read_bytes())
    ensure(summary.get('passed') is True and summary.get('scenario_status')=='passed',f'{group} summary failed')
    ensure(summary.get('execution_unchanged') is True and summary.get('production_unchanged') is True,f'{group} changed execution/production')
    ensure(summary.get('real_model_requests')==0 and summary.get('external_model_requests')==0,f'{group} external model request')
    ensure(summary.get('DSH_started') is False,f'{group} unexpectedly started DSH')
    scenarios=summary.get('scenarios')
    ensure(isinstance(scenarios,list) and len(scenarios)==expected_count,f'{group} scenario count mismatch')
    for item in scenarios:
        scenario=item['scenario_id']
        scenario_dir=PROOF/f'runs/{group}/scenarios/{scenario}'
        ui=json.loads((scenario_dir/'ui-result.json').read_bytes())
        authored=json.loads((scenario_dir/'ledger-verification.json').read_bytes())
        command=json.loads((scenario_dir/'ledger-verification.command.json').read_bytes())
        ensure(ui.get('passed') is True and ui.get('status')=='completed',f'{group}/{scenario} UI result failed')
        ensure(authored.get('passed') is True and authored.get('scenario')==scenario,f'{group}/{scenario} author ledger report failed')
        argv=command['argv']
        ensure(command.get('exit_code')==0 and '--profile-root' in argv and '--scenario' in argv and '--output' in argv,f'{group}/{scenario} source verification command invalid')
        profile=pathlib.Path(argv[argv.index('--profile-root')+1]).resolve(strict=True)
        ensure(profile.name=='profile' and profile.parent.name==scenario and profile.exists(),f'{group}/{scenario} source profile path mismatch')
        expected_run='desktop-full-02' if group=='full' else 'desktop-degradation-03'
        ensure(profile.parent.parent.name==expected_run,f'{group}/{scenario} final run path mismatch')
        readback=OUT/f'{group}-{scenario}.json'
        actual_command=[str(NODE),str(VERIFY),'--profile-root',str(profile),'--scenario',scenario,'--output',str(readback)]
        proc=subprocess.run(actual_command,cwd=WT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=60,check=False)
        ensure(proc.returncode==0,f'{group}/{scenario} read-only ledger verifier exit {proc.returncode}: {proc.stderr[:300]}')
        actual=json.loads(readback.read_bytes())
        ensure(actual.get('passed') is True and actual.get('scenario')==scenario,f'{group}/{scenario} fresh ledger report failed')
        ensure(actual.get('admission')==authored.get('admission') and actual.get('admitted_turns')==authored.get('admitted_turns') and actual.get('ledgerCount')==authored.get('ledgerCount'),f'{group}/{scenario} admission/count changed')
        ensure(len(actual.get('databases',[]))==len(authored.get('databases',[])),f'{group}/{scenario} ledger count changed')
        for old,new in zip(authored.get('databases',[]),actual.get('databases',[])):
            for key in ('passed','databaseRelativePath','databaseBytes','databaseSha256','admission','nativeEventCount','transcriptEventCount','factCount','observationCount'):
                ensure(old.get(key)==new.get(key),f'{group}/{scenario} database {key} changed')
            for turn_old,turn_new in zip(old.get('admittedTurns',[]),new.get('admittedTurns',[])):
                ensure(turn_old.get('lifecycle')==turn_new.get('lifecycle') and turn_old.get('nativeReceiptsVerified') is True and turn_new.get('nativeReceiptsVerified') is True and turn_old.get('transcriptReceiptsVerified') is True and turn_new.get('transcriptReceiptsVerified') is True and turn_old.get('terminalReceiptVerified') is True and turn_new.get('terminalReceiptVerified') is True,f'{group}/{scenario} attempt/receipt verification mismatch')
        if scenario=='no_key':
            ensure(actual.get('admission')=='not_admitted' and actual.get('admitted_turns')==0 and all(db.get('factCount')==0 for db in actual.get('databases',[])) and item.get('model_requests')==0,'no_key admitted facts/request')
        results.append({'suite':group,'scenario':scenario,'ui_passed':True,'ledger_passed':True,'admission':actual['admission'],'admitted_turns':actual['admitted_turns'],'ledgerCount':actual['ledgerCount'],'databaseFacts':[db.get('factCount') for db in actual.get('databases',[])],'readback_sha256':sha(readback.read_bytes()),'command':actual_command,'exit_code':proc.returncode})
print(json.dumps({'result':'pass','candidate_proof_archive_entries_verified':len(index['artifacts']),'full_scenarios':6,'degradation_scenarios':3,'ledger_reports_verified':len(results),'no_key_zero_admission_verified':True,'results':results},ensure_ascii=False))
