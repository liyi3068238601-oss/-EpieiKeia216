import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = 'E:\\Xiadie\\Xiadie';
const source = path.join(root, '.runtime/P01/desktop-source');
const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
assert.ok(input.startsWith(path.join(root, '.runtime/P03/experiments') + path.sep));
assert.ok(output.startsWith(path.join(root, '.runtime/P03') + path.sep));
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const raw = await readFile(input);
const report = JSON.parse(raw);
assert.equal(report.status, 'pass');
const entries = execFileSync('git', ['-C', source, 'ls-files', '--stage', '-z'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).split('\0').filter(Boolean);
const blobs = new Map(entries.map(entry => {
  const tab = entry.indexOf('\t');
  return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[1]];
}));
const checked = [];
let outputs = 0;
for (const pkg of report.results) {
  for (const file of pkg.inputs) {
    const relative = path.relative(source, file.path).split(path.sep).join('/');
    assert.ok(!relative.startsWith('../'));
    const bytes = await readFile(file.path);
    assert.equal(digest(bytes), file.sha256);
    const blob = blobs.get(relative);
    if (blob !== undefined) assert.equal(digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1'), blob, relative);
    checked.push({ path: relative, sha256: file.sha256, origin: blob === undefined ? 'ignored-generated-input' : 'tracked-native-source', ...(blob === undefined ? {} : { gitBlob: blob }) });
  }
  for (const file of pkg.outputs) {
    assert.equal(digest(await readFile(file.generated.path)), file.generated.sha256);
    assert.equal(digest(await readFile(file.existing.path)), file.generated.sha256);
    outputs += 1;
  }
}
const generatedInputs = checked.filter(row => !row.gitBlob);
assert.equal(generatedInputs.length, 1);
assert.equal(generatedInputs[0].path, 'apps/zcode-cli/packages/dynamic-workflow/src/compiler/libs.generated.ts');
const generatorRelative = 'apps/zcode-cli/packages/dynamic-workflow/scripts/generate-libs.mjs';
const generator = await readFile(path.join(source, generatorRelative));
assert.equal(digest(Buffer.concat([Buffer.from(`blob ${generator.length}\0`), generator]), 'sha1'), blobs.get(generatorRelative));
const freshPackage = path.join(path.dirname(input), 'generated-lib-readback');
await mkdir(freshPackage);
await mkdir(path.join(freshPackage, 'scripts'));
await mkdir(path.join(freshPackage, 'src/compiler'), { recursive: true });
await mkdir(path.join(freshPackage, 'node_modules'));
await copyFile(path.join(source, 'apps/zcode-cli/packages/dynamic-workflow/package.json'), path.join(freshPackage, 'package.json'));
await writeFile(path.join(freshPackage, 'scripts/generate-libs.mjs'), generator);
const nativeRequire = createRequire(path.join(source, 'apps/zcode-cli/packages/dynamic-workflow/package.json'));
const typescriptRoot = path.dirname(nativeRequire.resolve('typescript/package.json'));
await symlink(typescriptRoot, path.join(freshPackage, 'node_modules/typescript'), 'junction');
const generatorOutput = execFileSync(process.execPath, ['scripts/generate-libs.mjs'], { cwd: freshPackage, encoding: 'utf8' });
const generated = await readFile(path.join(freshPackage, 'src/compiler/libs.generated.ts'));
assert.equal(digest(generated), generatedInputs[0].sha256);
const stdlibs = JSON.parse(generated.toString('utf8').split('export const TS_LIBS: Record<string, string> = ')[1].trim().replace(/;$/, '').replace(/,\s*}$/, '}'));
const libInputs = [];
for (const [name, text] of Object.entries(stdlibs)) {
  const bytes = await readFile(path.join(typescriptRoot, 'lib', name));
  assert.equal(bytes.toString('utf8'), text);
  libInputs.push({ name, bytes: bytes.length, sha256: digest(bytes) });
}
const generatedReadback = { generator: { path: generatorRelative, gitBlob: blobs.get(generatorRelative), sha256: digest(generator) }, command: { executable: process.execPath, args: ['scripts/generate-libs.mjs'], cwd: freshPackage, exitCode: 0, stdout: generatorOutput }, generatedSha256: digest(generated), libInputs };
const result = { status: 'pass', commit: report.commit, compilationReport: { path: input, bytes: raw.length, sha256: digest(raw) }, inputs: checked, trackedInputs: checked.filter(row => row.gitBlob).length, generatedInputs, generatedReadback, byteIdenticalJavaScriptOutputs: outputs, limitation: 'Ignored generated inputs are separately identified and regenerated from the tracked generator plus installed TypeScript library bytes. Runtime dependency installation provenance is unchanged.' };
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'pass', trackedInputs: result.trackedInputs, generatedInputs: result.generatedInputs, outputs, report: output }));
