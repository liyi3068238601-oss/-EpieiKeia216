import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type SessionEvent = { type: string; data: Record<string, unknown> }
type Notification = {
  method: string
  params: Record<string, unknown>
}
type MockRecord = {
  method: string
  path: string
  fakeCredentialHeaderPresent: boolean
  model?: unknown
  tools: string[]
  messageTexts: string[]
}

function option(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`required argument --${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function textFromContent(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((block) => {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') return [block.text]
    return []
  })
}

function eventOf(notification: Notification): SessionEvent | undefined {
  if (notification.method !== 'session.event') return undefined
  const event = notification.params.event
  if (!event || typeof event !== 'object' || !('type' in event) || !('data' in event)) return undefined
  return event as SessionEvent
}

function isReceiptFor(notification: Notification, messageId: string): boolean {
  const event = eventOf(notification)
  if (event?.type !== 'agent/inbox/spliced') return false
  const inserted = event.data.inserted
  return Array.isArray(inserted) && inserted.some((item) => item && typeof item === 'object'
    && 'id' in item && item.id === messageId)
}

function assistantText(notification: Notification): string[] {
  const event = eventOf(notification)
  if (event?.type !== 'assistant/message') return []
  const message = event.data.message
  if (!message || typeof message !== 'object' || !('content' in message)) return []
  return textFromContent(message.content)
}

function recordOf(method: string, path: string, headers: IncomingMessage['headers'], body: unknown): MockRecord {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const messages = Array.isArray(value.messages) ? value.messages : []
  const messageTexts = messages.flatMap((message) => {
    if (!message || typeof message !== 'object' || !('content' in message)) return []
    return textFromContent(message.content)
  })
  const tools = Array.isArray(value.tools) ? value.tools.flatMap((tool) => {
    if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') return [tool.name]
    return []
  }) : []
  return {
    method,
    path,
    fakeCredentialHeaderPresent: [headers['x-api-key'], headers.authorization, headers['x-dsh-auth-token']]
      .some(value => typeof value === 'string' && value.length > 0),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    tools,
    messageTexts,
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function nextBefore<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(description)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return true
    return false
  }
}

async function waitForPidState(pid: number, expectedAlive: boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pidAlive(pid) === expectedAlive) return true
    await wait(40)
  }
  return pidAlive(pid) === expectedAlive
}

async function readPidRecord(path: string): Promise<{ runtimePid: number; grandchildPid?: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { runtimePid: number; grandchildPid?: number }
    } catch {
      await wait(25)
    }
  }
  throw new Error(`timed out waiting for owned fake runtime PID record ${path}`)
}

async function saveCase(outputDir: string, name: string, value: unknown): Promise<void> {
  const path = join(outputDir, `${name}.json`)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const root = resolve(option('root'))
  const outputDir = resolve(option('output-dir'))
  const sourceRoot = resolve(root, '.runtime/P00/dsh/source')
  const existing = await import(pathToFileURL(resolve(sourceRoot, 'packages/sdk/client/src/index.ts')).href) as {
    DeepSeekHarness: new (options: Record<string, unknown>) => {
      run(input: string | Array<{ type: 'text'; text: string }>, options?: { sessionId?: string }): Promise<{
        sessionId: string
        finalResponse: string
        events: SessionEvent[]
        notifications: Notification[]
      }>
      close(): Promise<void>
    }
    HarnessClient: new (options: Record<string, unknown>) => {
      initialize(params: Record<string, unknown>): Promise<{ serverInfo: { name: string; version: string } }>
      subscribeSessionTree(sessionId: string): { next(): Promise<Notification>; close(): void }
      prompt(sessionId: string, content: Array<{ type: 'text'; text: string }>): Promise<string>
      close(): Promise<void>
    }
  }
  const fixture = await import(pathToFileURL(resolve(sourceRoot, 'packages/llm/llm-deepseek/tests/mock-server.ts')).href) as {
    textEvents: string[]
  }
  const sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert(sourceCommit === '639ed015397290b3745d163aafe02ffee4aa3f84', `unexpected fixed source commit ${sourceCommit}`)

  const expectedTexts = ['P00-U09-FIRST-MOCK-ANSWER', 'P00-U09-SECOND-MOCK-ANSWER']
  const mockSseInterEventDelayMs = 35
  const responseEvents = (text: string): string[] => fixture.textEvents.map((source) => {
    const value = JSON.parse(source) as Record<string, unknown>
    if (value.type === 'content_block_delta' && value.delta && typeof value.delta === 'object') {
      return JSON.stringify({ ...value, delta: { ...(value.delta as Record<string, unknown>), text } })
    }
    return source
  })
  const requests: MockRecord[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const body = await readJson(request)
      requests.push(recordOf(request.method ?? '', url.pathname, request.headers, body))
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unexpected route' }))
        return
      }
      const answer = expectedTexts[requests.length - 1]
      if (answer === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'mock script exhausted' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of responseEvents(answer)) {
        response.write(`data: ${event}\n\n`)
        await wait(mockSseInterEventDelayMs)
      }
      response.end()
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })

  const envRoot = resolve(outputDir, 'child-env')
  const workspace = resolve(outputDir, 'workspace')
  const dshHome = resolve(outputDir, 'synthetic-dsh-home')
  const fakeCredential = 'P00-U09-FAKE-NO-REAL-CREDENTIAL'
  const windowsRoot = 'C:\\Windows'
  await Promise.all([
    mkdir(envRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(dshHome, { recursive: true }),
  ])
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert(address !== null && typeof address !== 'string', 'mock server did not bind a TCP port')
  const mockBaseUrl = `http://127.0.0.1:${address.port}`
  const patch = resolve(root, 'spikes/P00/dsh-runtime/disable-tools.cordis.patch.yml')
  const childEnv: Record<string, string> = {
    PATH: 'C:\\Program Files\\nodejs;C:\\Windows\\System32',
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: resolve(envRoot, 'userprofile'),
    APPDATA: resolve(envRoot, 'appdata'),
    LOCALAPPDATA: resolve(envRoot, 'localappdata'),
    TEMP: resolve(envRoot, 'temp'),
    TMP: resolve(envRoot, 'temp'),
    HOMEDRIVE: root.slice(0, 2),
    HOMEPATH: '\\Xiadie\\Xiadie\\evidence\\P00-U09\\20261001-01',
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: fakeCredential,
    DEEPSEEK_BASE_URL: mockBaseUrl,
  }
  const sessionId = `p00-u09-reopen-${Date.now()}`
  const firstPrompt = 'Remember this synthetic checkpoint exactly: CHECKPOINT-ALPHA-42.'
  const secondPrompt = 'Continue from the checkpoint and answer only the new request.'
  const start = Date.now()
  const launchOptions = {
    profile: 'sdk-minimal',
    patches: [patch],
    dshHome,
    processCwd: workspace,
    env: childEnv,
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 60_000,
    shutdownTimeoutMs: 3_000,
    disposeEofGraceMs: 10_000,
  }
  const client = new existing.HarnessClient(launchOptions)
  let subscription: ReturnType<typeof client.subscribeSessionTree> | undefined
  let output: Record<string, unknown>
  try {
    const initialize = await client.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    subscription = client.subscribeSessionTree(sessionId)
    const promptStartedAt = Date.now()
    const messageId = await client.prompt(sessionId, [{ type: 'text', text: firstPrompt }])
    let receiptMatched = false
    let idle = false
    const assistant: string[] = []
    const observed: Array<{ method: string; eventType?: string; status?: string }> = []
    const deadline = Date.now() + 30_000
    while (!idle) {
      const remaining = deadline - Date.now()
      assert(remaining > 0, 'timed out waiting for actual runtime idle notification')
      const notification = await nextBefore(
        subscription.next(), remaining, 'timed out waiting for actual runtime idle notification',
      )
      const event = eventOf(notification)
      observed.push({
        method: notification.method,
        ...(event ? { eventType: event.type } : {}),
        ...(notification.method === 'session.status' && typeof notification.params.status === 'string'
          ? { status: notification.params.status }
          : {}),
      })
      if (isReceiptFor(notification, messageId)) receiptMatched = true
      assistant.push(...assistantText(notification))
      if (notification.method === 'session.status'
        && notification.params.sessionId === sessionId && notification.params.status === 'idle') idle = true
    }
    const firstElapsedMs = Date.now() - start
    const firstPromptToIdleMs = Date.now() - promptStartedAt
    assert(receiptMatched, 'no durable agent/inbox/spliced receipt matched the returned messageId')
    assert(idle, 'no matching session.status idle observed')
    assert(assistant.join('') === expectedTexts[0], `assistant business text mismatch: ${assistant.join('')}`)
    const hostCheckpointPath = resolve(outputDir, 'host-completed-checkpoint.json')
    const hostCheckpoint = {
      schema: 'p00-u09-host-checkpoint-v1',
      status: 'completed',
      sessionId,
      messageId,
      inputSha256: createHash('sha256').update(firstPrompt).digest('hex'),
      outputText: assistant.join(''),
      outputSha256: createHash('sha256').update(assistant.join('')).digest('hex'),
      receiptMatched,
      idle,
      source: 'spike-owned host ledger; not DSH protocol state',
    }
    await writeFile(hostCheckpointPath, `${JSON.stringify(hostCheckpoint, null, 2)}\n`, 'utf8')
    await client.close()
    const persistedCheckpoint = JSON.parse(await readFile(hostCheckpointPath, 'utf8')) as typeof hostCheckpoint
    const checkpointBytes = await readFile(hostCheckpointPath)
    const hostCheckpointSha256 = createHash('sha256').update(checkpointBytes).digest('hex')
    const completedCheckpointRecovered = persistedCheckpoint.status === 'completed'
      && persistedCheckpoint.inputSha256 === createHash('sha256').update(firstPrompt).digest('hex')
      && persistedCheckpoint.outputSha256 === createHash('sha256').update(persistedCheckpoint.outputText).digest('hex')
      && persistedCheckpoint.receiptMatched && persistedCheckpoint.idle
    const recoveredCompletedOutput = completedCheckpointRecovered ? persistedCheckpoint.outputText : undefined
    const providerRequestsAtCheckpointRecovery = requests.length
    const unknownCheckpoint = {
      schema: 'p00-u09-host-checkpoint-v1',
      status: 'unknown',
      sessionId,
      messageId,
      inputSha256: createHash('sha256').update(firstPrompt).digest('hex'),
      reason: 'outcome-not-observed-before-restart',
      source: 'spike-owned host ledger; not DSH protocol state',
    }
    const unknownCheckpointPath = resolve(outputDir, 'host-unknown-checkpoint.json')
    await writeFile(unknownCheckpointPath, `${JSON.stringify(unknownCheckpoint, null, 2)}\n`, 'utf8')
    const persistedUnknownCheckpoint = JSON.parse(await readFile(unknownCheckpointPath, 'utf8')) as typeof unknownCheckpoint
    const unknownCheckpointBytes = await readFile(unknownCheckpointPath)
    const unknownCheckpointSha256 = createHash('sha256').update(unknownCheckpointBytes).digest('hex')
    const unknownRecoveryState = persistedUnknownCheckpoint.status === 'unknown' ? 'unknown' : 'completed'
    const providerResubmittedDuringCheckpointRecovery = requests.length !== providerRequestsAtCheckpointRecovery
    assert(completedCheckpointRecovered, 'completed host checkpoint did not validate after runtime close')
    assert(recoveredCompletedOutput === expectedTexts[0], 'completed checkpoint did not restore its saved result text')
    assert(unknownRecoveryState === 'unknown', 'unknown host checkpoint was treated as completed')
    assert(!providerResubmittedDuringCheckpointRecovery, 'checkpoint recovery resubmitted work to the provider')

    const highLevel = new existing.DeepSeekHarness(launchOptions)
    let sameIdResult: Awaited<ReturnType<typeof highLevel.run>> | undefined
    let sameIdReopenError: string | undefined
    try {
      try {
        sameIdResult = await highLevel.run(secondPrompt, { sessionId })
      } catch (error) {
        sameIdReopenError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
    } finally {
      await highLevel.close()
    }
    const requestsAfterSameIdAttempt = requests.length
    const sameIdRequest = requests[1]
    const priorPromptInSameIdRequest = sameIdRequest?.messageTexts.includes(firstPrompt) ?? false
    const priorAnswerInSameIdRequest = sameIdRequest?.messageTexts.includes(expectedTexts[0]) ?? false
    const sameIdHistoryObserved = priorPromptInSameIdRequest && priorAnswerInSameIdRequest
    let freshSessionResult: Awaited<ReturnType<typeof highLevel.run>> | undefined
    let freshSessionId: string | undefined
    if (sameIdResult === undefined) {
      assert(sameIdReopenError?.includes('already exists'), `same-id reopen failed unexpectedly: ${sameIdReopenError}`)
      assert(requestsAfterSameIdAttempt === 1, `same-id reopen unexpectedly reached the provider ${requestsAfterSameIdAttempt - 1} times`)
      freshSessionId = `${sessionId}-fresh`
      const freshRuntime = new existing.DeepSeekHarness(launchOptions)
      try {
        freshSessionResult = await freshRuntime.run(secondPrompt, { sessionId: freshSessionId })
      } finally {
        await freshRuntime.close()
      }
    }
    const highLevelResult = sameIdResult ?? freshSessionResult
    assert(highLevelResult !== undefined, 'neither same-id reopen nor fresh-session restart produced a result')
    const highLevelReceiptObserved = highLevelResult.events.some(event => event.type === 'agent/inbox/spliced')
    const highLevelIdleObserved = highLevelResult.notifications.some(notification =>
      notification.method === 'session.status'
        && notification.params.sessionId === highLevelResult.sessionId
        && notification.params.status === 'idle')
    const elapsedMs = Date.now() - start
    const sourcePaths = [
      'packages/sdk/client/src/index.ts',
      'packages/sdk/client/src/api.ts',
      'packages/sdk/client/src/client.ts',
      'packages/sdk/client/src/types.ts',
      'packages/sdk/client/src/launch.ts',
      'packages/sdk/client/src/dispose.ts',
      'packages/sdk/client/tests/fake-runtime.ts',
      'packages/sdk/server/src/server.ts',
      'packages/sdk/protocol/src/types.ts',
      'packages/llm/llm-deepseek/src/config.ts',
      'packages/llm/llm-deepseek/src/messages-api.ts',
      'packages/llm/llm-deepseek/src/adapter.ts',
      'packages/llm/llm-deepseek/tests/mock-server.ts',
      'packages/bundle/sdk-minimal/cordis.patch.yml',
    ]
    const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => {
      const contents = await (await import('node:fs/promises')).readFile(resolve(sourceRoot, path))
      return [path, createHash('sha256').update(contents).digest('hex')]
    })))
    assert(initialize.serverInfo.name === 'deepseek-harness-sdk-runtime', 'unexpected serverInfo.name')
    assert(initialize.serverInfo.version === '0.0.1', 'unexpected serverInfo.version')
    assert(messageId.length > 0, 'prompt returned an empty messageId')
    assert(receiptMatched, 'no durable agent/inbox/spliced receipt matched the returned messageId')
    assert(idle, 'no matching session.status idle observed')
    assert(assistant.join('') === expectedTexts[0], `assistant business text mismatch: ${assistant.join('')}`)
    assert(highLevelResult.finalResponse === expectedTexts[1], `DeepSeekHarness finalResponse mismatch: ${highLevelResult.finalResponse}`)
    assert(highLevelResult.sessionId === (sameIdResult ? sessionId : freshSessionId), 'DeepSeekHarness returned a different sessionId')
    assert(highLevelReceiptObserved, 'DeepSeekHarness RunResult omitted the inbox receipt event')
    assert(highLevelIdleObserved, 'DeepSeekHarness notifications omitted idle')
    assert(requests.length === 2, `expected two local provider requests across restart; saw ${requests.length}`)
    assert(requests.every(request => request.method === 'POST' && request.path === '/v1/messages'), 'unexpected provider route in captured requests')
    assert(requests.every(request => request.fakeCredentialHeaderPresent), 'loopback provider request omitted its fake credential header')
    assert(requests[0].messageTexts.includes(firstPrompt), 'first mock provider request omitted the submitted prompt')
    assert(requests[1].messageTexts.includes(secondPrompt), 'reopened mock provider request omitted the new prompt')
    assert(requests.every(request => request.tools.length === 0), `test profile still advertised tools: ${JSON.stringify(requests.map(request => request.tools))}`)

    const fakeCasesRoot = resolve(outputDir, 'fake-runtime-cases')
    const fakeLauncher = resolve(root, 'spikes/dsh-sdk/fake-runtime-launcher.mjs')
    const fakeRuntimeSource = resolve(sourceRoot, 'packages/sdk/client/tests/fake-runtime.ts')
    const makeFakeOptions = async (
      name: string,
      extras: Record<string, string> = {},
      overrides: Record<string, unknown> = {},
    ): Promise<{ caseDir: string; options: Record<string, unknown>; pidFile: string }> => {
      const caseDir = resolve(fakeCasesRoot, name)
      const caseHome = resolve(caseDir, 'synthetic-dsh-home')
      const caseEnvRoot = resolve(caseDir, 'child-env')
      const pidFile = resolve(caseDir, 'owned-pids.json')
      await Promise.all([
        mkdir(caseHome, { recursive: true }),
        mkdir(caseEnvRoot, { recursive: true }),
      ])
      const env = {
        ...childEnv,
        DSH_HOME: caseHome,
        USERPROFILE: resolve(caseEnvRoot, 'userprofile'),
        APPDATA: resolve(caseEnvRoot, 'appdata'),
        LOCALAPPDATA: resolve(caseEnvRoot, 'localappdata'),
        TEMP: resolve(caseEnvRoot, 'temp'),
        TMP: resolve(caseEnvRoot, 'temp'),
        P00_U09_FAKE_RUNTIME_SOURCE: fakeRuntimeSource,
        P00_U09_PID_FILE: pidFile,
        ...extras,
      }
      return {
        caseDir,
        pidFile,
        options: { ...launchOptions, dshBin: fakeLauncher, dshHome: caseHome, env, ...overrides },
      }
    }
    const protocolFaults: Array<Record<string, unknown>> = []

    const duplicateCase = await makeFakeOptions('duplicate-receipt', {
      P00_U09_DUPLICATE_RECEIPT: '1',
      FAKE_TEXT: 'P00-U09-DUPLICATE-RECEIPT-OK',
    })
    const duplicateHarness = new existing.DeepSeekHarness(duplicateCase.options)
    let duplicateResult: Awaited<ReturnType<typeof duplicateHarness.run>>
    try {
      duplicateResult = await duplicateHarness.run('Synthetic duplicate notification probe.')
    } finally {
      await duplicateHarness.close()
    }
    const duplicateReceiptCount = duplicateResult.events.filter(event => event.type === 'agent/inbox/spliced').length
    const duplicateIdle = duplicateResult.notifications.some(notification =>
      notification.method === 'session.status' && notification.params.status === 'idle')
    assert(duplicateReceiptCount >= 2, `fake runtime duplicate receipt count was ${duplicateReceiptCount}`)
    assert(duplicateIdle, 'duplicate receipt case did not reach idle')
    assert(duplicateResult.finalResponse === 'P00-U09-DUPLICATE-RECEIPT-OK', 'duplicate receipt case business text mismatch')
    const duplicateData = {
      status: 'passed',
      source: 'fixed SDK client fake-runtime.ts behind a local wrapper; protocol fixture only, not actual server/provider',
      receiptNotificationsObserved: duplicateReceiptCount,
      idleObserved: duplicateIdle,
      finalResponse: duplicateResult.finalResponse,
      observation: 'Duplicate durable receipt events are retained in RunResult.events; the duplicate did not prevent idle or the scripted assistant result.',
    }
    protocolFaults.push({ case: 'duplicate-receipt', ...duplicateData })
    await saveCase(duplicateCase.caseDir, 'result', duplicateData)

    const noFinalCase = await makeFakeOptions('no-final', { FAKE_EMPTY_MESSAGE: '1', FAKE_TEXT: 'not-emitted' })
    const noFinalHarness = new existing.DeepSeekHarness(noFinalCase.options)
    let noFinalResult: Awaited<ReturnType<typeof noFinalHarness.run>>
    try {
      noFinalResult = await noFinalHarness.run('Synthetic no-final business result probe.')
    } finally {
      await noFinalHarness.close()
    }
    const noFinalIdle = noFinalResult.notifications.some(notification =>
      notification.method === 'session.status' && notification.params.status === 'idle')
    const noFinalAssistantEvent = noFinalResult.events.some(event => event.type === 'assistant/message')
    assert(noFinalIdle, 'no-final fake case did not reach idle')
    assert(noFinalAssistantEvent, 'no-final fixture omitted its empty assistant/message event')
    assert(noFinalResult.finalResponse === '', `no-final business result was not empty: ${noFinalResult.finalResponse}`)
    const noFinalData = {
      status: 'passed',
      source: 'fixed SDK client fake-runtime.ts FAKE_EMPTY_MESSAGE fixture; protocol fixture only, not actual server/provider',
      idleObserved: noFinalIdle,
      assistantEventObserved: noFinalAssistantEvent,
      finalResponse: noFinalResult.finalResponse,
      interpretation: 'Idle plus a messageId receipt does not imply non-empty business output; this fixture emitted an empty assistant content array.',
    }
    protocolFaults.push({ case: 'no-final', ...noFinalData })
    await saveCase(noFinalCase.caseDir, 'result', noFinalData)

    const dirtyCase = await makeFakeOptions('dirty-stdout', { P00_U09_DIRTY_STDOUT: '1' }, {
      initializeTimeoutMs: 600,
    })
    const dirtyClient = new existing.HarnessClient(dirtyCase.options)
    let dirtyFailure: string | undefined
    try {
      await dirtyClient.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    } catch (error) {
      dirtyFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    } finally {
      await dirtyClient.close()
    }
    const dirtyPids = await readPidRecord(dirtyCase.pidFile)
    const dirtyChildExited = await waitForPidState(dirtyPids.runtimePid, false)
    assert(dirtyFailure !== undefined, 'dirty stdout unexpectedly passed initialize')
    assert(dirtyChildExited, 'dirty stdout fake runtime remained alive after close')
    const dirtyData = {
      status: 'passed',
      expectedFailure: dirtyFailure,
      runtimeChildPid: dirtyPids.runtimePid,
      runtimeChildExitedAfterClose: dirtyChildExited,
      interpretation: 'A non-JSON stdout banner broke initialize framing; close reaped the directly-owned fake runtime process.',
    }
    protocolFaults.push({ case: 'dirty-stdout', ...dirtyData })
    await saveCase(dirtyCase.caseDir, 'result', dirtyData)

    const forcedCase = await makeFakeOptions('forced-direct-child-kill', {
      FAKE_IGNORE_EOF: '1',
      FAKE_TRAP_SIGTERM: '1',
    }, {
      disposeEofGraceMs: 200,
      disposeGraceMs: 2_000,
      shutdownTimeoutMs: 1_000,
    })
    const forcedClient = new existing.HarnessClient(forcedCase.options)
    await forcedClient.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const forcedPids = await readPidRecord(forcedCase.pidFile)
    const forcedCloseStarted = Date.now()
    await forcedClient.close()
    const forcedCloseMs = Date.now() - forcedCloseStarted
    const forcedChildExited = await waitForPidState(forcedPids.runtimePid, false)
    assert(forcedChildExited, 'SDK close did not reap the EOF-ignoring direct runtime child')
    const forcedData = {
      status: 'passed',
      runtimeChildPid: forcedPids.runtimePid,
      eofGraceMs: 200,
      closeResolved: true,
      closeMs: forcedCloseMs,
      runtimeChildExited: forcedChildExited,
      platform: process.platform,
      interpretation: 'SDK whole-runtime shutdown escalated against an EOF-ignoring runtime and awaited direct-child exit; it is not per-prompt cancellation.',
    }
    protocolFaults.push({ case: 'forced-direct-child-kill', ...forcedData })
    await saveCase(forcedCase.caseDir, 'result', forcedData)

    const treeCase = await makeFakeOptions('direct-child-vs-grandchild', {
      FAKE_IGNORE_EOF: '1',
      FAKE_TRAP_SIGTERM: '1',
      P00_U09_SPAWN_GRANDCHILD: '1',
    }, {
      disposeEofGraceMs: 200,
      disposeGraceMs: 2_000,
      shutdownTimeoutMs: 1_000,
    })
    const treeClient = new existing.HarnessClient(treeCase.options)
    await treeClient.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const treePids = await readPidRecord(treeCase.pidFile)
    assert(treePids.grandchildPid !== undefined, 'owned runtime did not record the synthetic grandchild PID')
    const grandchildAliveBeforeSdkClose = pidAlive(treePids.grandchildPid)
    assert(grandchildAliveBeforeSdkClose, 'synthetic grandchild was not alive before SDK close')
    await treeClient.close()
    const runtimeExited = await waitForPidState(treePids.runtimePid, false)
    const grandchildAliveAfterSdkClose = pidAlive(treePids.grandchildPid)
    let ownedGrandchildCleanupAttempted = false
    let ownedGrandchildExited = false
    if (grandchildAliveAfterSdkClose) {
      ownedGrandchildCleanupAttempted = true
      process.kill(treePids.grandchildPid, 'SIGKILL')
      ownedGrandchildExited = await waitForPidState(treePids.grandchildPid, false)
    }
    assert(runtimeExited, 'SDK close did not terminate the direct runtime child')
    assert(grandchildAliveAfterSdkClose, 'synthetic grandchild did not survive direct-child teardown; descendant boundary was not demonstrated')
    assert(ownedGrandchildExited, 'the exact synthetic grandchild PID was not cleaned up')
    const treeData = {
      status: 'passed',
      runtimeChildPid: treePids.runtimePid,
      ownedGrandchildPid: treePids.grandchildPid,
      sdkCloseTerminatedDirectChild: runtimeExited,
      grandchildAliveBeforeSdkClose,
      grandchildAliveAfterSdkClose,
      grandchildDetachedByLauncher: true,
      sdkProvidedProcessTreeGuarantee: false,
      cleanup: { exactOwnedPidOnly: true, attempted: ownedGrandchildCleanupAttempted, exited: ownedGrandchildExited },
      interpretation: 'The fake runtime launched its synthetic helper with detached:true. SDK close reaped the direct runtime child while the detached helper remained alive; the spike immediately terminated only the recorded owned PID. This shows no SDK guarantee for detached descendants and does not characterize every attached child configuration.',
    }
    protocolFaults.push({ case: 'direct-child-vs-grandchild', ...treeData })
    await saveCase(treeCase.caseDir, 'result', treeData)
    assert(!Object.hasOwn(childEnv, 'HOME'), 'child environment unexpectedly contains HOME')
    output = {
      status: sameIdResult === undefined ? 'passed_with_limit' : 'passed',
      case: 'actual-sdk-loopback-receipt-idle-business-result-reopen',
      sourceCommit,
      initialize: initialize.serverInfo,
      sessionId,
      messageId,
      receiptMatched,
      idle,
      assistantText: assistant.join(''),
      firstClientCloseResolved: true,
      highLevelRun: {
        sessionId: highLevelResult.sessionId,
        finalResponse: highLevelResult.finalResponse,
        receiptObserved: highLevelReceiptObserved,
        idleObserved: highLevelIdleObserved,
      },
      restartCheck: {
        reusedSameDshHome: true,
        reusedSameSessionId: true,
        sameIdAttemptRequestCountAfter: requestsAfterSameIdAttempt,
        sameIdReopenError,
        priorPromptInSecondProviderRequest: priorPromptInSameIdRequest,
        priorAssistantAnswerInSecondProviderRequest: priorAnswerInSameIdRequest,
        sameIdPersistedHistoryObserved: sameIdHistoryObserved,
        interpretation: sameIdHistoryObserved
          ? 'Observed persisted conversation history in the second runtime request for the same session id; this is empirical same-id recovery, not an explicit protocol resume method.'
          : sameIdReopenError
            ? 'Same-id re-open was rejected before provider dispatch as already existing. No protocol resume method is exposed; persistent history recovery is not available through this SDK path.'
            : 'History was not observed in the second request; resume/recovery is not proven by this attempt.',
      },
      hostCheckpointRecovery: {
        implementation: 'spike-owned completed-result checkpoint; not a native DSH resume protocol',
        file: 'host-completed-checkpoint.json',
        sha256: hostCheckpointSha256,
        completedCheckpointRecovered,
        recoveredOutputText: recoveredCompletedOutput,
        unknownStateFile: 'host-unknown-checkpoint.json',
        unknownStateSha256: unknownCheckpointSha256,
        unknownStatePreserved: unknownRecoveryState === 'unknown',
        providerRequestsAtRecovery: providerRequestsAtCheckpointRecovery,
        providerResubmittedDuringRecovery: providerResubmittedDuringCheckpointRecovery,
        interpretation: 'After SDK close, a new disk read verifies and returns the saved completed result; an unknown-state file remains unknown and is held without auto-retry. This is a spike-owned completed-result checkpoint, not crash-consistency or native DSH same-id resume.',
      },
      freshSessionAfterRestart: freshSessionResult ? {
        sessionId: freshSessionResult.sessionId,
        finalResponse: freshSessionResult.finalResponse,
        receiptObserved: highLevelReceiptObserved,
        idleObserved: highLevelIdleObserved,
        carriedPreviousHistory: requests[1].messageTexts.includes(firstPrompt),
      } : null,
      protocolFaults,
      slowResponse: {
        interEventDelayMs: mockSseInterEventDelayMs,
        frameCount: fixture.textEvents.length,
        firstPromptToIdleMs,
      },
      firstElapsedMs,
      elapsedMs,
      notifications: observed,
      mockRequests: requests,
      childEnvironment: {
        replacesParentEnvironment: true,
        homeVariablePresent: Object.hasOwn(childEnv, 'HOME'),
        isolatedUserProfile: childEnv.USERPROFILE,
        syntheticDshHome: dshHome,
        fakeCredentialUsed: childEnv.DEEPSEEK_API_KEY === fakeCredential,
        credentialRecorded: false,
        endpoint: mockBaseUrl,
      },
      profile: 'sdk-minimal',
      disabledToolsPatch: patch,
      sourceSha256: sourceHashes,
      paidModelCalls: 0,
      promptSentToLoopbackMock: true,
      actualProductRuntimeTest: false,
    }
  } catch (error) {
    output = {
      status: 'failed',
      case: 'actual-sdk-loopback-receipt-idle-business-result',
      sourceCommit,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      mockRequests: requests,
      paidModelCalls: 0,
    }
    throw error
  } finally {
    subscription?.close()
    await client.close()
    await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'probe.json'), `${JSON.stringify(output!, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
