// Test fixture preparation through the pinned native storage API; no model or UI import.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const source = spec.source;
const url = relative => pathToFileURL(path.join(source, relative)).href;
const {register} = await import(url('node_modules/tsx/dist/esm/api/index.mjs'));
register();
const {createConfig} = await import(url('apps/zcode-cli/packages/adapters/dist/config/index.js'));
const {SqliteSessionStore} = await import(url('apps/zcode-cli/packages/adapters/dist/storage/session-store.js'));
const {getSessionDbPath} = await import(url('apps/zcode-cli/packages/bootstrap/dist/app/session-store.js'));
const {projectIdFromDirectory} = await import(url('apps/zcode-cli/packages/bootstrap/dist/app/paths.js'));
const dbPath = getSessionDbPath(createConfig({env:process.env}), spec.workspace);
assert.ok(path.relative(spec.profile_root, dbPath) && !path.relative(spec.profile_root, dbPath).startsWith('..'));
const store = new SqliteSessionStore({dbPath});
const now = Date.now();
const sessionId = spec.session_id;
try {
  await store.createSession({id:sessionId,projectID:projectIdFromDirectory(spec.workspace),
    slug:'u08-no-key-history',directory:spec.workspace,path:spec.workspace,title:spec.user_marker,
    titleSource:'custom',version:'0.1.0',permission:{mode:'plan'},time:{created:now,updated:now+1}});
  const userId = `${sessionId}_fixture_user`;
  const assistantId = `${sessionId}_fixture_assistant`;
  await store.saveMessage({id:userId,sessionID:sessionId,role:'user',time:{created:now},agent:'zcode-agent'});
  await store.saveMessage({id:assistantId,sessionID:sessionId,role:'assistant',parentID:userId,
    time:{created:now+1,completed:now+1},mode:'plan',agent:'zcode-agent',path:{cwd:spec.workspace,root:spec.workspace},
    cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},finish:'stop'});
  for (const [id,text,at] of [[userId,spec.user_marker,now],[assistantId,spec.assistant_marker,now+1]]) {
    await store.savePart({id:`${id}_text`,sessionID:sessionId,messageID:id,type:'text',text,
      time:{start:at,end:at},metadata:{fixture:'P01-U08-synthetic'}});
  }
} finally { store.close(); }
await writeFile(`${spec.out}/seed-result.json`,JSON.stringify({dbPath,sessionId,records:2,
  method:'Native SqliteSessionStore createSession/saveMessage/savePart',model_requests:0,synthetic:true},null,2));
