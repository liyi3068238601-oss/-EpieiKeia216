import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createDefaultProfile, resolveOwnedProfilePaths, buildChildEnvironment} from '../../../dist/packages/config/src/index.js';
const canary = 'U08_PARENT_SECRET_MUST_NOT_ENTER_CHILD';
const profile = createDefaultProfile();
const paths = resolveOwnedProfilePaths(process.argv[2]);
const env = buildChildEnvironment(paths, {systemEnv:{...process.env, OPENAI_API_KEY:canary,
  DEEPSEEK_API_KEY:canary, NODE_OPTIONS:canary, HTTP_PROXY:canary}, endpointOrigin:process.argv[4]});
assert.ok(!JSON.stringify({profile,paths,env}).includes(canary));
const modulePath = new URL('../../../dist/packages/config/src/index.js', import.meta.url);
writeFileSync(process.argv[3], JSON.stringify({profile,paths,env,
  code_sha256:createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
  inherited_secret_canary_absent:true},null,2)+'\n');
