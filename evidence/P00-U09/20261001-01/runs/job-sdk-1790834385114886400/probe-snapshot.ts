import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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
        await wait(35)
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
    await client.close()

    const highLevel = new existing.DeepSeekHarness(launchOptions)
    let highLevelResult: Awaited<ReturnType<typeof highLevel.run>>
    try {
      highLevelResult = await highLevel.run(secondPrompt, { sessionId })
    } finally {
      await highLevel.close()
    }
    const reopenedRecord = requests[1]
    const priorPromptInSecondRequest = reopenedRecord?.messageTexts.includes(firstPrompt) ?? false
    const priorAnswerInSecondRequest = reopenedRecord?.messageTexts.includes(expectedTexts[0]) ?? false
    const sameIdHistoryObserved = priorPromptInSecondRequest && priorAnswerInSecondRequest
    const highLevelReceiptObserved = highLevelResult.events.some(event => event.type === 'agent/inbox/spliced')
    const highLevelIdleObserved = highLevelResult.notifications.some(notification =>
      notification.method === 'session.status'
        && notification.params.sessionId === sessionId
        && notification.params.status === 'idle')
    const elapsedMs = Date.now() - start
    const sourcePaths = [
      'packages/sdk/client/src/index.ts',
      'packages/sdk/client/src/api.ts',
      'packages/sdk/client/src/client.ts',
      'packages/sdk/client/src/types.ts',
      'packages/sdk/client/src/launch.ts',
      'packages/sdk/client/src/dispose.ts',
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
    assert(highLevelResult.sessionId === sessionId, 'DeepSeekHarness returned a different sessionId')
    assert(highLevelReceiptObserved, 'DeepSeekHarness RunResult omitted the inbox receipt event')
    assert(highLevelIdleObserved, 'DeepSeekHarness notifications omitted idle')
    assert(requests.length === 2, `expected two local provider requests across restart; saw ${requests.length}`)
    assert(requests.every(request => request.method === 'POST' && request.path === '/v1/messages'), 'unexpected provider route in captured requests')
    assert(requests.every(request => request.fakeCredentialHeaderPresent), 'loopback provider request omitted its fake credential header')
    assert(requests[0].messageTexts.includes(firstPrompt), 'first mock provider request omitted the submitted prompt')
    assert(requests[1].messageTexts.includes(secondPrompt), 'reopened mock provider request omitted the new prompt')
    assert(requests.every(request => request.tools.length === 0), `test profile still advertised tools: ${JSON.stringify(requests.map(request => request.tools))}`)
    assert(!Object.hasOwn(childEnv, 'HOME'), 'child environment unexpectedly contains HOME')
    output = {
      status: 'passed',
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
        priorPromptInSecondProviderRequest: priorPromptInSecondRequest,
        priorAssistantAnswerInSecondProviderRequest: priorAnswerInSecondRequest,
        sameIdPersistedHistoryObserved: sameIdHistoryObserved,
        interpretation: sameIdHistoryObserved
          ? 'Observed persisted conversation history in the second runtime request for the same session id; this is empirical same-id recovery, not an explicit protocol resume method.'
          : 'History was not observed in the second request; resume/recovery is not proven by this attempt.',
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
