import json,pathlib,hashlib,os
R=pathlib.Path(r'.runtime/P02/worktrees/mature-freeze/evidence/P02-U11/20261004-02')
E=R
for suite,ids in [('full',['success','read_success','read_failure','cancel_recovery','disabled_native','pro_denied']),('degradation',['no_key','no_dsh','offline'])]:
 print('\nSUITE',suite)
 sm=json.loads((E/f'candidate-proof/runs/{suite}/summary.json').read_bytes())
 print('summary', {k:sm.get(k) for k in ['passed','scenario_status','real_model_requests','external_model_requests','real_credentials_used','DSH_started','visual_acceptance','execution_unchanged','production_unchanged']})
 print('closure',sm.get('candidate_artifact_closure_after_suite'))
 print('registry',sm.get('registry_side_effect_state'))
 for sid in ids:
  d=E/f'candidate-proof/runs/{suite}/scenarios/{sid}'
  s=json.loads((d/'scenario-result.json').read_bytes()); l=json.loads((d/'ledger-verification.json').read_bytes()); ng=s.get('network_guard',{}); b=s.get('sqlite_runtime_binding',{}); a=s.get('sqlite_cli_runtime_alias',{}); g=s.get('registry_write_guard',{}); ui=s.get('actual_ui',{}).get('desktop',{})
  m=json.loads((E/f'runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/main-process-runtime.json').read_bytes())
  al=json.loads((E/f'runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/sqlite-cli-runtime-alias.json').read_bytes())
  log=(E/f'runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/registry-write-guard.jsonl').read_bytes()
  rec=[json.loads(x) for x in log.decode().splitlines() if x]
  print(sid, json.dumps({
   'scenario':{k:s.get(k) for k in ['passed','exit_code','scenario_id','candidate_artifact_closure']},
   'ledger':{k:l.get(k) for k in ['passed','admission','admitted_turns','ledger_count','ledgerCount','qualificationBoundary']},
   'binding':{k:b.get(k) for k in ['passed','status','probes','cli_guarded_pids']},
   'ui_main_pid':ui.get('main_pid'),'main':m,
   'net_main':ng.get('main'),'cli_guarded_pids':ng.get('cli_guarded_pids'),
   'guard':g,'logs':{'count':len(rec),'sha':hashlib.sha256(log).hexdigest(),'first':rec[:1]},
   'alias_bind':a,'aliasfile':al,
   'runner':json.loads((E/f'candidate-proof/runs/{suite}/p02-desktop-runner.json').read_bytes()).get('qualificationBoundary')
  },ensure_ascii=False)[:6000])
print('\nCOMMANDS')
idx=json.loads((E/'command-index.json').read_bytes())
for c in idx['commands']:
 x=json.loads((E/c['path']).read_bytes()); print(c['path'], c.get('exit_code'), x.get('argv'), 'cmd',x.get('command'))
print('\nDOC TOKENS')
for p in ['docs/releases/0.2.0/README.md','docs/releases/0.2.0/freeze.json','evidence/P02-U11/20261004-02/result.md','evidence/P02-U11/20261004-02/source-decision.md','evidence/P02-U11/20261004-02/rollback.md','docs/evals/P02/requirement-evidence.md']:
 q=pathlib.Path(r'.runtime/worktrees/mature-freeze')/p
 # use WT actual
 q=pathlib.Path(r'.runtime/P02/worktrees/mature-freeze')/p
 t=q.read_text(encoding='utf-8')
 print(p, len(t), [x for x in ['Electron 41.0.3','ELECTRON_RUN_AS_NODE=1','Node 24.14.0','node:sqlite','sandbox','ready_for_review','accepted:false','P03 has not started','fixed Node CLI','new onboarding-timeout fallback','not an OS sandbox','source sha256','103'] if x.casefold() in t.casefold()])
 if p.endswith('freeze.json'):
  obj=json.loads(t); print('groups',obj.get('input_groups')); print('boundary',obj.get('native_storage_boundary'), 'known',obj.get('known_qualification_text_limitations'))
