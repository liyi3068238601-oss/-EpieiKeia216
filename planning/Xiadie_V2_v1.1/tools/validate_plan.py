#!/usr/bin/env python3
"""Offline planning-package validation, not product tests."""
from pathlib import Path
import json,re,sys
root=Path(__file__).resolve().parent.parent
errors=[]
def get(f,k):
 try:return json.loads((root/f).read_text(encoding='utf8'))[k]
 except Exception as e:errors.append(f'{f}: {e}');return []
tasks=get('tasks.json','tasks');sources=get('sources.json','sources');stages=get('versions.json','stages');reqs=get('requirements.json','requirements')
by={x['id']:x for x in tasks};sid={x['id'] for x in sources};rid={x['id'] for x in reqs}
if len(by)!=len(tasks):errors.append('duplicate task ID')
seen=set();active=set()
def walk(i):
 if i in active:errors.append('cycle '+i);return
 if i in seen or i not in by:return
 active.add(i)
 for dep in by[i]['dependencies']:walk(dep)
 active.remove(i);seen.add(i)
for t in tasks:
 i=t['id']
 if not re.fullmatch(r'P\d{2}-U\d{2}',i):errors.append('invalid ID '+i)
 if t['status']!='not_started':errors.append('planning copy execution state changed '+i)
 if len(t['steps'])<3:errors.append('too few concrete steps '+i)
 for k in ['scope','inputs','test','done','output']:
  if not t.get(k):errors.append('missing '+k+' '+i)
 for dep in t['dependencies']:
  if dep not in by:errors.append('unknown dependency '+i+' '+dep)
 if not t['refs']:errors.append('no source '+i)
 for x in t['refs']:
  if x not in sid:errors.append('unknown source '+i+' '+x)
 for q in t['requirements']:
  if q not in rid:errors.append('unknown requirement '+i+' '+q)
 if not (root/'tasks'/(i+'.md')).is_file():errors.append('missing card '+i)
 walk(i)
for st in stages:
 ts=[by[x] for x in st['task_ids']]
 if [x['kind'] for x in ts[:2]]!=['research','spike']:errors.append('missing find/try '+st['code'])
 if ts[-1]['kind']!='gate':errors.append('missing gate '+st['code'])
 impl={x['id'] for x in ts if x['kind']=='implementation'}
 if not impl.issubset(set(ts[-2]['dependencies'])):errors.append('integration misses units '+st['code'])
for q in reqs:
 if not q['tasks']:errors.append('unmapped requirement '+q['id'])
 for i in q['tasks']:
  if i not in by:errors.append('unknown task in requirement '+q['id'])
report={'status':'FAIL' if errors else 'PASS','document_version':'1.1','stages':len(stages),'tasks':len(tasks),'sources':len(sources),'requirements':len(reqs),'product_tests_run':False,'errors':errors}
print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(bool(errors))
