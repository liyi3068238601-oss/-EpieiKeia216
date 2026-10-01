import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport, JsonRpcResponseError } from '../../../references/dsh-639ed015/packages/sdk/protocol/src/transport.ts'

const checks = []

function complete(name) {
  checks.push(name)
}

async function withTimeout(promise, label, ms = 1500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Exercise request/result, request/error mapping, and outbound notification over
// paired PassThrough byte streams with a small mock JSON-RPC peer.
{
  const clientToPeer = new PassThrough()
  const peerToClient = new PassThrough()
  const client = new JsonRpcLineTransport(peerToClient, clientToPeer)
  const peer = new JsonRpcLineTransport(clientToPeer, peerToClient)
  let resolveNotification
  const notificationSeen = new Promise(resolve => { resolveNotification = resolve })
  peer.onRequest(async (method, params) => {
    if (method === 'session/prompt') return { messageId: 'mock-receipt-42', accepted: params.sessionId }
    if (method === 'explode') throw new Error('mock handler fault')
    throw new Error(`unexpected mock method: ${method}`)
  })
  peer.onNotification((method, params) => resolveNotification({ method, params }))
  client.start()
  peer.start()

  const receipt = await withTimeout(client.request('session/prompt', { sessionId: 'mock-session' }), 'mock receipt')
  assert.deepEqual(receipt, { messageId: 'mock-receipt-42', accepted: 'mock-session' })

  const failure = await withTimeout(client.request('explode', {}), 'mock error').then(
    () => { throw new Error('mock error request unexpectedly succeeded') },
    error => error,
  )
  assert.ok(failure instanceof JsonRpcResponseError)
  assert.equal(failure.code, -32603)
  assert.equal(failure.message, 'mock handler fault')

  client.notify('host.notice', { source: 'poc', count: 1 })
  assert.deepEqual(await withTimeout(notificationSeen, 'notification'), {
    method: 'host.notice',
    params: { source: 'poc', count: 1 },
  })
  client.close()
  peer.close()
  complete('mock peer request receipt, handler error mapping, and notification')
}

// Feed malformed and non-frame lines, then a valid frame whose CJK UTF-8 code
// point is split between Buffer chunks. The same endpoint must recover and
// normalize a notification with omitted params.
{
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = new JsonRpcLineTransport(input, output)
  const seen = []
  let resolveFrames
  const bothFramesSeen = new Promise(resolve => { resolveFrames = resolve })
  transport.onNotification((method, params) => {
    seen.push({ method, params })
    if (seen.length === 2) resolveFrames()
  })
  transport.start()

  input.write('not json\n')
  input.write('\n')
  input.write('null\n')
  input.write('{"jsonrpc":"2.0","params":{}}\n')
  const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'utf8.fragment', params: { text: '前缀：昔涟🙂' } })}\n`)
  const characterOffset = frame.indexOf(Buffer.from('昔'))
  assert.ok(characterOffset >= 0)
  input.write(frame.subarray(0, characterOffset + 1))
  input.write(frame.subarray(characterOffset + 1))
  input.write('{"jsonrpc":"2.0","method":"tick"}\n')

  await withTimeout(bothFramesSeen, 'valid notifications after malformed lines')
  assert.deepEqual(seen, [
    { method: 'utf8.fragment', params: { text: '前缀：昔涟🙂' } },
    { method: 'tick', params: {} },
  ])
  transport.close()
  complete('malformed-frame recovery, fragmented UTF-8, newline framing, and omitted params')
}

// Closing a caller-owned transport rejects an outstanding request and detaches
// the transport listeners without destroying its PassThrough streams.
{
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = new JsonRpcLineTransport(input, output)
  transport.start()
  const pending = transport.request('never.replied', {})
  transport.close()
  await assert.rejects(pending, /JSON-RPC transport closed/)
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.listenerCount('error'), 0)
  assert.equal(input.listenerCount('end'), 0)
  assert.equal(input.destroyed, false)
  assert.equal(output.destroyed, false)
  complete('close rejects pending request, detaches listeners, and preserves caller-owned streams')
}

console.log(JSON.stringify({
  status: 'PASS',
  scope: 'fixed JsonRpcLineTransport source with in-memory PassThrough mock peer; not DSH SDK or product runtime',
  checks,
}, null, 2))