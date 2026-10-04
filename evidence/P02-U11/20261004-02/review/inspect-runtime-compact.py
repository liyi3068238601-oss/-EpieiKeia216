import json,pathlib,hashlib
E=pathlib.Path(r'.runtime/P02/worktrees/mature-freeze/evidence/P02-U11/20261004-02')
for suite,ids in [('full',['success','read_success','read_failure','cancel_recovery','disabled_native','pro_denied']),('degradation',['no_key','no_dsh','offline'])]:
 print('\nSUITE',suite)
 for sid in ids:
  d=E/f'candidate-proof/runs/{suite}/scenarios/{sid}'
  s=json.loads((d/'scenario-result.json').read_bytes()); l=json.loads((d/'ledger-verification.json').read_bytes()); ng=s.get('network_guard',{}); b=s.get('sqlite_runtime_binding',{}); a=s.get('sqlite_cli_runtime_alias',{}); g=s.get('registry_write_guard',{}); ui=s.get('actual_ui',{}).get('desktop',{})
  m=json.loads((E/f'runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/main-process-runtime.json').read_bytes())
  al=json.loads((E/f'runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/sqlite-cli-runtime-alias.json').read_bytes())
  print(sid,json.dumps({
   's':{k:s.get(k) for k in ['passed','exit_code','candidate_artifact_closure']},
   'l':{k:l.get(k) for k in ['passed','admission','admitted_turns','ledgerCount','ledger_count']},
   'bind':{k:b.get(k) for k in ['passed','status','cli_guarded_pids']},
   'uiPid':ui.get('main_pid'),'netMain':ng.get('main'),'main':{k:m.get(k) for k in ['pid','processType','execPath']},
   'guard':{k:g.get(k) for k in ['passed','os_sandbox','request_count','main_pid','launcher_pid','blocked_requests_sha256','raw_requests_path','main_process_snapshot_path']},
   'alias':{k:al.get(k) for k in ['passed','alias_entry_realpath','entry_sha256']},
   'scenarioAlias':{k:a.get(k) for k in ['passed','realpath','entry_sha256']}
  },ensure_ascii=False))
print('\nRUNNER')
for suite in ['full','degradation']:
 x=json.loads((E/f'candidate-proof/runs/{suite}/p02-desktop-runner.json').read_bytes());print(suite, json.dumps({k:x.get(k) for k in ['exitCode','qualificationBoundary','electronRuntime','nodeRuntime','argv','cwd','candidateDescriptorSha256']}))
print('\nFREEZE SUMMARY')
f=json.loads((pathlib.Path(r'.runtime/P02/worktrees/mature-freeze/docs/releases/0.2.0/freeze.json')).read_bytes())
print('groups total',sum(x['count'] for x in f.get('input_groups',{}).values()), 'groups', {k:v['count'] for k,v in f.get('input_groups',{}).items()})
r=(E/'result.md').read_text(encoding='utf8')
print('result lines')
for ln in r.splitlines():
 if any(t in ln.lower() for t in ['p03','fixed node','onboarding','not_instantiated','disabled','ready_for_review','accepted:false','electron','registry']): print(ln)
print('\nDOC REQ group assertions etc')
