// Original research bootstrap, invoked only after job-gate has been assigned.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--root');
if (at < 0) throw new Error('--root is required');
const root = resolve(process.argv[at + 1]);
const probeAt = process.argv.indexOf('--probe');
if (probeAt < 0) throw new Error('--probe is required');
const probe = resolve(process.argv[probeAt + 1]);
const source = resolve(root, '.runtime/P00/dsh/source');
process.env.TSX_TSCONFIG_PATH = resolve(source, 'packages/sdk/client/tsconfig.json');
const { tsImport } = await import(pathToFileURL(resolve(source, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
await tsImport(pathToFileURL(probe).href, { parentURL: import.meta.url, tsconfig: process.env.TSX_TSCONFIG_PATH });
