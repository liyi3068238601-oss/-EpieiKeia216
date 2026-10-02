// Local development Desktop assembly from the accepted Apache-2.0 ZCode pin.
// Source stays read-only. Only startup's read-only admission is changed in memory.
import assert from 'node:assert/strict';
import {cp, lstat, mkdir, readFile, realpath, stat, writeFile, symlink, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

export const SOURCE_PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e';

function isInsidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function resolveThroughPhysicalAncestor(candidateValue) {
  let current = path.resolve(candidateValue);
  const missingSegments = [];

  while (true) {
    try {
      const physical = await realpath(current);
      if (!(await stat(physical)).isDirectory()) {
        throw new Error('Desktop output path and its existing ancestor must be directories');
      }
      return path.resolve(physical, ...missingSegments);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;

      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error('Desktop output path contains an unresolved symbolic link');
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== 'ENOENT' && inspectionError?.code !== 'ENOTDIR') {
          throw inspectionError;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) throw new Error('Desktop output path has no existing physical ancestor');
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveDesktopBuildPaths(sourceValue, destinationValue) {
  const source = await realpath(path.resolve(sourceValue));
  if (!(await stat(source)).isDirectory()) throw new Error('Pinned Desktop source must be a directory');
  const assemblyRoot = await resolveThroughPhysicalAncestor(destinationValue);
  if (isInsidePath(source, assemblyRoot)) {
    throw new Error('Desktop output must be outside the physical reference source tree');
  }
  return {source, assemblyRoot};
}

export function patchReadOnlyWarmup(text) {
  const start = text.indexOf('    async initialize(params: ZCodeAgentWorkspaceTarget)');
  const end = text.indexOf('    async syncAppRuntimePreferences(', start);
  assert.ok(start >= 0 && end > start, 'Pinned initialize boundary changed');
  const block = text.slice(start,end);
  const needle = 'const client = await getClient(params);';
  assert.equal(block.split(needle).length, 2, 'Pinned warmup call is missing or ambiguous');
  return text.slice(0,start) + block.replace(needle,
    'const client = await getClient(params).catch((error) => {\n' +
    '          if (!isProviderNotReadyError(error)) throw error;\n' +
    '          return getReadOnlyClient(params);\n' +
    '        });') + text.slice(end);
}

export async function buildDesktop(sourceValue, destinationValue) {
  const {source, assemblyRoot} = await resolveDesktopBuildPaths(sourceValue, destinationValue);
  const destination = path.join(assemblyRoot,'packages/desktop');
  const git = (...args) => execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
  assert.equal(git('rev-parse','HEAD'),SOURCE_PIN);
  assert.equal(git('status','--porcelain'),'');
  await mkdir(assemblyRoot,{recursive:false});
  await mkdir(destination,{recursive:true});
  const desktop = path.join(source,'packages/desktop');
  const nativeOutput = path.join(desktop,'out');
  await mkdir(path.join(destination,'out'));
  for (const item of ['main','preload','renderer','metadata']) {
    await cp(path.join(nativeOutput,item),path.join(destination,'out',item),{recursive:true,errorOnExist:true});
  }
  await cp(path.join(desktop,'package.json'),path.join(destination,'package.json'));
  await cp(path.join(source,'LICENSE'),path.join(assemblyRoot,'UPSTREAM-LICENSE'));
  await mkdir(path.join(assemblyRoot,'config/provider'),{recursive:true});
  for (const item of ['default.json','provider/zcode-builtin.json']) {
    await cp(path.join(source,'config',item),path.join(assemblyRoot,'config',item));
  }
  const cliRelative = 'apps/zcode-cli/packages/cli/dist';
  await mkdir(path.join(assemblyRoot,cliRelative),{recursive:true});
  for (const item of ['zcode.cjs','THIRD-PARTY-NOTICES.md']) {
    await cp(path.join(source,cliRelative,item),path.join(assemblyRoot,cliRelative,item));
  }
  // Development artifact: exact pinned dependencies are reused for loading only.
  // No install/build runs in this junction and this artifact is not an installer.
  await symlink(path.join(source,'node_modules'),path.join(assemblyRoot,'node_modules'),'junction');
  const require = createRequire(path.join(source,'package.json'));
  const {register} = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  register();
  const {build} = await import(pathToFileURL(require.resolve('tsup')).href);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.chdir(desktop);
  let patched = 0;
  let inputSha, patchedSha;
  try {
    const {default:configs} = await import(pathToFileURL(path.join(desktop,'tsup.config.ts')).href);
    const host = configs.find(x=>x.name==='host');
    assert.ok(host);
    await build({...host,config:false,outDir:path.join(destination,'out'),clean:false,onSuccess:undefined,
      entry:Object.fromEntries(Object.entries(host.entry).map(([key,value])=>[key,path.join(desktop,value)])),
      esbuildOptions(options,context) { host.esbuildOptions(options,context); options.absWorkingDir=desktop; },
      esbuildPlugins:[{name:'xiadie-no-key-readonly-warmup',setup(builder) {
        builder.onLoad({filter:/zcodeAgentService\.ts$/},async args=>{
          assert.equal(path.resolve(args.path),path.join(source,'packages/services/src/zcode-agent/zcodeAgentService.ts'));
          const original = await readFile(args.path,'utf8');
          const contents = patchReadOnlyWarmup(original);
          inputSha = createHash('sha256').update(original).digest('hex');
          patchedSha = createHash('sha256').update(contents).digest('hex');
          patched++;
          return {contents,loader:'ts',resolveDir:path.dirname(args.path)};
        });
      }}]});
    assert.equal(patched,1);
  } finally {
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV=previousNodeEnv;
  }
  assert.equal(git('status','--porcelain'),'');
  const artifacts = [];
  async function bindDirectory(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(directory,entry.name);
      assert.equal(entry.isSymbolicLink(),false);
      if (entry.isDirectory()) await bindDirectory(file);
      else {
        const data=await readFile(file);
        artifacts.push({path:path.relative(assemblyRoot,file).replaceAll('\\','/'),bytes:data.length,
          sha256:createHash('sha256').update(data).digest('hex')});
      }
    }
  }
  await bindDirectory(assemblyRoot);
  const info = {source,source_commit:SOURCE_PIN,assemblyRoot,destination,patch_count:patched,input_sha256:inputSha,
    patched_sha256:patchedSha,scope:'initialize falls back to read-only client only on provider_not_ready; model/write admission unchanged',
    dependencies:'Pinned reference node_modules junction; local development artifact, not portable installer',
    main_unchanged:true,renderer_unchanged:true,preload_unchanged:true,artifacts,
    recipe_sha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')};
  await writeFile(path.join(destination,'xiadie-build.json'),JSON.stringify(info,null,2)+'\n');
  return info;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildDesktop(process.argv[2],process.argv[3])));
}
