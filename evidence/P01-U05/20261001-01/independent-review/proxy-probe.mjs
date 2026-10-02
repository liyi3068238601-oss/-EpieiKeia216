import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = 'E:/Xiadie/Xiadie/.runtime/P01/worktrees/u05';
const context = await import(pathToFileURL(path.join(root, 'dist/packages/context/src/index.js')));
const characterModule = await import(pathToFileURL(path.join(root, 'dist/packages/character/src/index.js')));
const assets = path.join(root, 'assets/character');
const character = characterModule.loadCharacter(assets);
const baseInput = () => ({ scope: 'conversation-turn', version: '1', max_tokens: 32768, state: [], evidence: [], content: [] });
const results = [];

// The descriptor walk validates 32768, 1, 2, then the fourth read bypasses the maximum.
{
  const target = baseInput();
  let reads = 0;
  const values = [32768, 1, 2, 1_048_577];
  const input = new Proxy(target, { get(object, key, receiver) {
    if (key === 'max_tokens') return values[reads++] ?? Reflect.get(object, key, receiver);
    return Reflect.get(object, key, receiver);
  }});
  const packet = context.buildContextPacket(character, input);
  const parsed = JSON.parse(context.renderContextPacket(packet));
  assert.equal(reads, 4);
  assert.equal(packet.budget.max_tokens, 1_048_577);
  assert.equal(parsed.budget.max_tokens, 1_048_577);
  results.push({case:'max_tokens_proxy_bypasses_maximum', passed:true, proxy_get_reads:reads, emitted_max_tokens:parsed.budget.max_tokens, allowed_max_tokens:1_048_576});
}

// The check sees one reference; the subsequent map sees seventeen.
{
  const targetRecord = { source_refs: ['ref:one'], value: { text: 'x' } };
  let reads = 0;
  const overLimit = Array.from({length:17}, (_, i) => `ref:${i}`);
  const record = new Proxy(targetRecord, { get(object, key, receiver) {
    if (key === 'source_refs') return ++reads <= 3 ? ['ref:one'] : overLimit;
    return Reflect.get(object, key, receiver);
  }});
  const packet = context.buildContextPacket(character, baseInput());
  // Construct with the proxy record in content and require all seventeen to survive.
  const packetWithRefs = context.buildContextPacket(character, {...baseInput(), content:[record]});
  assert.equal(reads, 4);
  assert.equal(packetWithRefs.content[0].source_refs.length, 17);
  results.push({case:'source_refs_proxy_bypasses_per_record_limit', passed:true, proxy_get_reads:reads, emitted_refs:packetWithRefs.content[0].source_refs.length, allowed_refs:16});
}

// A Proxy that the JsonValue descriptor walk accepts runs its get trap during snapshot cloning.
{
  let reads = 0;
  const value = new Proxy({marker:'safe'}, { get(object, key, receiver) {
    if (key === 'marker') { reads += 1; return 'safe'; }
    return Reflect.get(object, key, receiver);
  }});
  const packet = context.buildContextPacket(character, {...baseInput(), content:[{source_refs:['memory:probe'], value}]});
  assert.equal(reads, 1);
  assert.equal(packet.content[0].value.marker, 'safe');
  results.push({case:'json_value_proxy_get_trap_runs_during_snapshot', passed:true, proxy_get_reads:reads, accepted:true});
}

console.log(JSON.stringify({diagnostic:'current built output; not final commit acceptance', node:process.version, results}, null, 2));
