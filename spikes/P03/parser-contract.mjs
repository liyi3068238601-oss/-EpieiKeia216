// U02 probe of the mature parsers already pinned by accepted U01; no product adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = 'E:\\Xiadie\\Xiadie';
const source = path.join(root, '.runtime/P01/desktop-source');
const output = path.resolve(process.argv[2] ?? '');
assert.ok(output.startsWith(path.join(root, '.runtime/P03') + path.sep));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceManifestPath = path.join(root, '.runtime/P03/preparation/parser-source-review/source-manifest.json');
const sourceManifestBytes = await readFile(sourceManifestPath);
assert.equal(sha(sourceManifestBytes), '684d3046dcda8792a5fac944367f78871d4388fced7a7eed8ef8c36889a189f8');
const sourceManifest = JSON.parse(sourceManifestBytes);
const packages = [];
for (const pkg of sourceManifest.installedPackages) {
  for (const entry of pkg.files) {
    const bytes = await readFile(path.join(root, pkg.path, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha(bytes), entry.sha256, `${pkg.name}/${entry.path}`);
  }
  packages.push({ name: pkg.name, filesVerified: pkg.files.length, packageInventorySha256: pkg.canonicalInventorySha256 });
}
const nativeRequire = createRequire(path.join(source, 'package.json'));
const marked = await import(pathToFileURL(nativeRequire.resolve('marked')).href);
const yaml = nativeRequire('yaml');
assert.equal(nativeRequire('marked/package.json').version, '16.4.2');
assert.equal(nativeRequire('yaml/package.json').version, '2.9.0');
const checks = [];
const check = (name, action) => { const detail = action(); checks.push({ name, status: 'pass', detail }); };

check('Markdown uses token boundaries for comments, code, direct and reference links', () => {
  const markdown = '<!-- [hidden](../other/secret.md) -->\n\n[Selected][topic]\n\n[topic]: selected.md\n\n```md\n<!-- keep this code example -->\n[not-a-link](code-only.md)\n```\n\nInline <!-- [hidden-inline](hidden.md) --> [Visible](visible.md)\n';
  const tokens = new marked.Lexer({ gfm: false }).lex(markdown);
  const links = [];
  const html = [];
  const code = [];
  marked.walkTokens(tokens, token => {
    if (token.type === 'link') links.push(token.href);
    if (token.type === 'html') html.push(token.raw);
    if (token.type === 'code') code.push(token.text);
  });
  assert.deepEqual(links, ['selected.md', 'visible.md']);
  assert.ok(html.length >= 2);
  assert.ok(code[0].includes('<!-- keep this code example -->'));
  return { links, htmlTokens: html.length, codePreserved: true, limitation: 'Lexer does not authorize href paths' };
});
check('YAML preserves an untouched raw frontmatter sample and parses YAML 1.2 data', () => {
  const original = Buffer.from('recorded_at: 2023-10-08\nstatus: experience\nflag: yes\n');
  const before = sha(original);
  const doc = yaml.parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(original), { strict: true, uniqueKeys: true });
  assert.equal(doc.errors.length, 0); assert.equal(doc.warnings.length, 0);
  assert.deepEqual(doc.toJS({ maxAliasCount: 0 }), { recorded_at: '2023-10-08', status: 'experience', flag: 'yes' });
  assert.equal(sha(original), before);
  return { originalSha256: before, rawBytesUnchanged: true };
});
for (const [label, input, expected] of [
  ['truncated flow', 'title: [broken\n', 'errors'],
  ['duplicate keys', 'status: old\nstatus: new\n', 'errors'],
  ['multiple documents', 'status: old\n---\nstatus: new\n', 'errors'],
  ['unknown tag', 'status: !unsafe value\n', 'warnings'],
]) {
  check(`YAML reports ${label} rather than an empty-success object`, () => {
    const doc = yaml.parseDocument(input, { strict: true, uniqueKeys: true });
    assert.ok(doc[expected].length > 0);
    return { errors: doc.errors.map(error => error.code), warnings: doc.warnings.map(warning => warning.code) };
  });
}
check('YAML alias expansion can be explicitly forbidden', () => {
  const doc = yaml.parseDocument('base: &base [one, two]\ncopy: *base\n');
  assert.equal(doc.errors.length, 0);
  let aliases = 0;
  yaml.visit(doc, (_key, node) => { if (yaml.isAlias(node)) aliases += 1; });
  assert.equal(aliases, 1);
  assert.throws(() => doc.toJS({ maxAliasCount: 0 }), /alias/i);
  return { aliases, conversionRejected: true };
});
check('Fatal UTF-8 belongs before the parsers', () => {
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from([0xc3, 0x28])));
  return { invalidBytesRejected: true, limitation: 'Parsers accept strings; caller must bound bytes, topics and nesting' };
});
const currentRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localRequire = createRequire(path.join(currentRepo, 'package.json'));
const availability = Object.fromEntries(['marked', 'yaml'].map(name => {
  try { return [name, { available: true, resolved: localRequire.resolve(name) }]; }
  catch (error) { assert.equal(error.code, 'MODULE_NOT_FOUND'); return [name, { available: false, code: error.code }]; }
}));
const result = {
  schema: 'p03-u02-parser-contract/v1', status: 'pass', node: process.version,
  scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  sourceManifest: { path: sourceManifestPath, sha256: sha(sourceManifestBytes) }, packages, checks,
  xiadieDependencyAvailability: availability,
  conclusion: 'Reuse Marked 16.4.2 and yaml 2.9.0 via explicit direct dependencies in U04; never import production parsers from an absolute reference checkout. Add package/lock/licenses as documented scope mapping. No handwritten Markdown/YAML parser.',
  limitations: ['U02 parser API probe only, not the U04 reader or host integration', 'No install or source/global configuration mutation', 'Path authorization, index budgets, frontmatter boundary extraction and four-state adapter belong to U04'],
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, checks: checks.length, packages, output }));
