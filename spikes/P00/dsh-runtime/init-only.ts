import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '../../../.runtime/P00/dsh/source/packages/sdk/client/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../../..')
const isolated = resolve(projectRoot, '.runtime/P00/dsh')
const envRoot = resolve(isolated, 'env')
const dshHome = resolve(isolated, 'dsh-home')
const workspace = resolve(here, 'workspace')
const patch = resolve(here, 'disable-tools.cordis.patch.yml')
const testMode = process.argv[2] ?? 'good'
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const childEnv = {
  PATH: 'C:\\Program Files\\nodejs;C:\\Windows\\System32',
  SystemRoot: systemRoot,
  WINDIR: systemRoot,
  ComSpec: resolve(systemRoot, 'System32/cmd.exe'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  USERPROFILE: resolve(envRoot, 'userprofile'),
  APPDATA: resolve(envRoot, 'appdata'),
  LOCALAPPDATA: resolve(envRoot, 'localappdata'),
  TEMP: resolve(envRoot, 'temp'),
  TMP: resolve(envRoot, 'temp'),
  HOMEDRIVE: 'E:',
  HOMEPATH: '\\Xiadie\\Xiadie\\.runtime\\P00\\dsh\\env\\userprofile',
  DSH_HOME: dshHome,
  DEEPSEEK_API_KEY: 'P00-U02-FAKE-NO-REAL-CREDENTIAL',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
}

const client = new HarnessClient({
  profile: 'sdk-minimal',
  patches: [patch],
  dshHome,
  processCwd: workspace,
  env: childEnv,
  initializeTimeoutMs: 60_000,
  shutdownTimeoutMs: 3_000,
  disposeEofGraceMs: 10_000,
})

try {
  const route = testMode === 'bad'
    ? { provider: 'p00-u02-missing-provider', model: 'p00-u02-invalid-model' }
    : { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  if (testMode === 'bad') {
    let failure: unknown
    try {
      await client.initialize({ cwd: workspace, ...route })
    } catch (error) {
      failure = error
    }
    if (failure === undefined) throw new Error('bad route unexpectedly initialized')
    process.stdout.write(`${JSON.stringify({
      status: 'expected_initialize_failure',
      route,
      errorName: failure instanceof Error ? failure.name : 'unknown',
      errorMessage: failure instanceof Error ? failure.message : String(failure),
      profile: 'sdk-minimal',
      modelCall: 'NOT_SENT',
      prompt: 'NOT_SENT',
    })}\n`)
  } else {
    const result = await client.initialize({ cwd: workspace, ...route })
    process.stdout.write(`${JSON.stringify({
      status: 'initialize_ok',
      result,
      route,
      profile: 'sdk-minimal',
      modelCall: 'NOT_SENT',
      prompt: 'NOT_SENT',
      isolatedHome: dshHome,
      isolatedWorkspace: workspace,
      homeVariablePresent: Object.hasOwn(childEnv, 'HOME'),
      fakeCredentialUsed: true,
      apiEndpoint: childEnv.DEEPSEEK_BASE_URL,
    })}\n`)
  }
} finally {
  await client.close()
}
