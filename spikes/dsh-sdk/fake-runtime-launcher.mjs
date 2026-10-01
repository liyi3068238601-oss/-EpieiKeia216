import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const env = process.env
const pidFile = env.P00_U09_PID_FILE
let grandchild

if (env.P00_U09_SPAWN_GRANDCHILD !== undefined) {
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  })
  grandchild.unref()
}

if (env.P00_U09_DIRTY_STDOUT !== undefined) process.stdout.write('P00-U09-DIRTY-STDOUT')

const originalWrite = process.stdout.write.bind(process.stdout)
if (env.P00_U09_DUPLICATE_RECEIPT !== undefined) {
  process.stdout.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString(
      typeof encoding === 'string' ? encoding : undefined,
    )
    try {
      const frame = JSON.parse(text.trim())
      if (frame.method === 'session.event' && frame.params?.event?.type === 'agent/inbox/spliced') {
        originalWrite(chunk, encoding, callback)
        originalWrite(chunk, encoding)
        return true
      }
    } catch (_notOneJsonRpcFrame) {
      // Forward non-frame writes unchanged; the dirty stdout case is intentional.
    }
    return originalWrite(chunk, encoding, callback)
  }
}

if (pidFile) {
  if (grandchild?.pid === undefined && env.P00_U09_SPAWN_GRANDCHILD !== undefined) {
    await new Promise(resolve => grandchild.once('spawn', resolve))
  }
  writeFileSync(pidFile, `${JSON.stringify({
    runtimePid: process.pid,
    ...(grandchild?.pid === undefined ? {} : { grandchildPid: grandchild.pid }),
  })}\n`, 'utf8')
}

const fakeRuntime = env.P00_U09_FAKE_RUNTIME_SOURCE
if (!fakeRuntime) throw new Error('P00_U09_FAKE_RUNTIME_SOURCE is required')
await import(pathToFileURL(fakeRuntime).href)
