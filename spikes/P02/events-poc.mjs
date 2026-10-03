// Isolated policy experiment. This is not the product event contract or a Runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('invalid JSON facts');
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const key = (source, id) => canonical([source, id]);
const scopeKey = event => canonical([event.session_id, event.turn_id, event.run_id, event.task_id]);
const terminal = new Set(['completed', 'failed', 'cancelled']);
class PolicyLedger {
  facts = new Map();
  attempts = new Map();
  current = new Map();
  audit = [];
  start(scope, attempt) {
    const owner = scopeKey(scope);
    const current = this.current.get(owner);
    if (current && !this.attempts.get(key(owner, current)).terminal) throw new Error('previous attempt remains open');
    const attemptKey = key(owner, attempt);
    if (this.attempts.has(attemptKey)) throw new Error('attempt already exists');
    this.current.set(owner, attempt);
    this.attempts.set(attemptKey, { terminal: undefined, draft: [], reply: undefined, watermark: 0 });
  }
  append(event) {
    const { observed_at, ...facts } = event;
    assert.ok(observed_at && Number.isSafeInteger(facts.source_seq) && facts.source_seq > 0);
    const identity = key(facts.source, facts.event_id);
    // Native duplicate append may assign another sequence to the same source ID.
    const { source_seq, ...identityFacts } = facts;
    const digest = hash(identityFacts);
    const prior = this.facts.get(identity);
    if (prior) {
      if (prior.hash !== digest) {
        this.audit.push({ event_id: event.event_id, status: 'identity_conflict', preserved_hash: prior.hash });
        return 'conflict';
      }
      if (prior.facts.source_seq !== source_seq) this.audit.push({ event_id: event.event_id,
        status: 'redelivery_resequenced', first_source_seq: prior.facts.source_seq, observed_source_seq: source_seq });
      return 'duplicate';
    }
    const owner = scopeKey(facts);
    const attempt = this.attempts.get(key(owner, facts.attempt_id));
    if (!attempt) throw new Error('unregistered scope/attempt');
    // Atomic in-memory candidate only. Actual SQLite transactions are a separate PoC.
    this.facts.set(identity, { hash: digest, facts, first_observed_at: observed_at });
    if (facts.source_seq < attempt.watermark) this.audit.push({ event_id: event.event_id, status: 'out_of_order' });
    attempt.watermark = Math.max(attempt.watermark, facts.source_seq);
    if (attempt.terminal || this.current.get(owner) !== facts.attempt_id) {
      this.audit.push({ event_id: event.event_id, status: 'late_audit_only' });
      return 'audit_only';
    }
    if (terminal.has(facts.kind)) {
      attempt.terminal = { kind: facts.kind, event_id: facts.event_id };
      if (facts.kind === 'completed' && typeof facts.payload.response === 'string') attempt.reply = facts.payload.response;
    } else if (facts.kind === 'stream') attempt.draft.push({ sequence: facts.source_seq, text: facts.payload.delta });
    return 'committed';
  }
  project(scope) {
    const owner = scopeKey(scope);
    const attemptId = this.current.get(owner);
    const attempt = this.attempts.get(key(owner, attemptId));
    return { attempt_id: attemptId, lifecycle: attempt.terminal?.kind ?? 'in_progress',
      reply: attempt.reply ?? null,
      draft: [...attempt.draft].sort((a, b) => a.sequence - b.sequence).map(item => item.text).join('') };
  }
}

const scope = { session_id: 'synthetic-session', turn_id: 'synthetic-turn', run_id: 'synthetic-run', task_id: 'synthetic-task' };
const event = (id, kind, sequence, attempt = 'a1', payload = {}) => ({ ...scope,
  source: 'zcode/pin/synthetic-session', event_id: id, attempt_id: attempt, kind,
  occurred_at: '2026-10-03T00:00:00.000Z', observed_at: '2026-10-03T00:00:01.000Z', source_seq: sequence, payload });
const cases = [];
function test(name, fn) { fn(); cases.push({ name, status: 'pass', boundary: 'synthetic policy experiment' }); }
test('same identity/facts redelivery is a no-op despite changed observed time', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  const original = event('one', 'progress', 1, 'a1', { b: 2, a: 1 });
  assert.equal(ledger.append(original), 'committed');
  assert.equal(ledger.append({ ...original, observed_at: '2026-10-03T00:02:00.000Z', payload: { a: 1, b: 2 } }), 'duplicate');
  assert.equal(ledger.facts.size, 1);
});
test('same identity/different facts cannot overwrite the original or seal a turn', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('collision', 'progress', 1));
  const original = ledger.facts.get(key('zcode/pin/synthetic-session', 'collision')).hash;
  assert.equal(ledger.append(event('collision', 'completed', 1, 'a1', { response: 'fabricated' })), 'conflict');
  assert.equal(ledger.facts.get(key('zcode/pin/synthetic-session', 'collision')).hash, original);
  assert.equal(ledger.project(scope).lifecycle, 'in_progress');
});
test('identity is source plus event ID, not a cross-session/global sequence', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('same-id', 'progress', 1));
  assert.equal(ledger.append({ ...event('same-id', 'progress', 1), source: 'other-runtime/source' }), 'committed');
  assert.equal(ledger.facts.size, 2);
});
test('native duplicate append may resequence the same ID without creating a new fact', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('resequence', 'progress', 1));
  assert.equal(ledger.append(event('resequence', 'progress', 2)), 'duplicate');
  assert.equal(ledger.facts.size, 1);
  assert.equal(ledger.facts.get(key('zcode/pin/synthetic-session', 'resequence')).facts.source_seq, 1);
  assert.ok(ledger.audit.some(item => item.status === 'redelivery_resequenced'));
});
test('sequence ties belong to distinct source IDs and cannot deduplicate unrelated facts', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('tie-one', 'progress', 1));
  assert.equal(ledger.append(event('tie-two', 'progress', 1)), 'committed');
  assert.equal(ledger.facts.size, 2);
});
test('progress watermark cannot discard an older but valid terminal', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('progress', 'progress', 9));
  ledger.append(event('finish', 'completed', 8, 'a1', { response: 'authoritative' }));
  assert.equal(ledger.project(scope).lifecycle, 'completed');
  assert.ok(ledger.audit.some(item => item.status === 'out_of_order'));
});
test('cancel/complete race preserves the first committed terminal in both orders', () => {
  for (const first of ['cancelled', 'completed']) {
    const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
    ledger.append(event('first', first, 1, 'a1', { response: 'final' }));
    assert.equal(ledger.append(event('second', first === 'cancelled' ? 'completed' : 'cancelled', 2, 'a1', { response: 'late' })), 'audit_only');
    assert.equal(ledger.project(scope).lifecycle, first);
    assert.equal(ledger.project(scope).reply, first === 'completed' ? 'final' : null);
  }
});
test('late success from an old attempt cannot finish the current attempt', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('failure', 'failed', 2)); ledger.start(scope, 'a2');
  assert.equal(ledger.append(event('late', 'completed', 3, 'a1', { response: 'late' })), 'audit_only');
  assert.equal(ledger.project(scope).attempt_id, 'a2');
  assert.equal(ledger.project(scope).lifecycle, 'in_progress');
});
test('partial streams remain drafts and failed turns have no formal reply', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  ledger.append(event('s2', 'stream', 2, 'a1', { delta: 'two' }));
  ledger.append(event('s1', 'stream', 1, 'a1', { delta: 'one' }));
  assert.equal(ledger.project(scope).draft, 'onetwo');
  assert.equal(ledger.project(scope).reply, null);
  ledger.append(event('error', 'failed', 3));
  assert.equal(ledger.project(scope).reply, null);
});
test('unregistered scope is rejected without committing a fact', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  assert.throws(() => ledger.append({ ...event('foreign', 'completed', 1), turn_id: 'other-turn' }), /unregistered/);
  assert.equal(ledger.facts.size, 0);
});
test('retry requires a sealed earlier attempt and a fresh attempt identity', () => {
  const ledger = new PolicyLedger(); ledger.start(scope, 'a1');
  assert.throws(() => ledger.start(scope, 'a2'), /remains open/);
  ledger.append(event('cancel', 'cancelled', 1));
  assert.throws(() => ledger.start(scope, 'a1'), /already exists/);
  ledger.start(scope, 'a2');
  assert.equal(ledger.project(scope).lifecycle, 'in_progress');
});

const out = path.resolve(process.argv[2] ?? '');
const allowed = path.resolve('E:/Xiadie/Xiadie/.runtime/P02/experiments/u02/events');
assert.equal(out, allowed, 'explicit owned output root required');
await mkdir(out, { recursive: true });
const report = { schema_version: 1, task: 'P02-U02', status: 'pass', cases,
  node: process.version, command: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd(),
  source: 'CloudEvents source+id identity design and accepted U01 native observation; no copied implementation',
  limitations: ['In-memory synthetic policy experiment; no product contract or persistence proof',
    'Commit ordering stands for serial writer acceptance; source_seq records runtime order separately and resequencing is an audit observation',
    'Native unassigned sequence=0 must be normalized at the adapter boundary, not silently treated as a committed sequence',
    'No native Loop, Desktop, real model, physical power loss or production transcript used'] };
await writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: cases.length, output: path.join(out, 'summary.json') }));
