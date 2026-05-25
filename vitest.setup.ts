/**
 * Vitest global setup — heritage test CJS bridge
 *
 * The B6 heritage test uses `require('./queries.js')` (CJS) to call
 * `explainDataFlow`. In forks mode, Vitest injects a pure Node.js CJS
 * `createRequire` as the `require` global, which means Node's native
 * CJS resolver runs. Because `queries.js` does not exist on disk
 * (the project is ESM-only with TypeScript source), the resolver throws
 * "Cannot find module './queries.js'".
 *
 * Fix:
 *  1. ESM-import `./src/code-intel/queries.js` — Vitest/Vite resolves this
 *     via the TypeScript transform pipeline and returns the live module.
 *  2. Synthesise a `Module` entry and register it in `Module._cache` under
 *     the path that CJS resolution would produce.
 *  3. Patch `Module._resolveFilename` narrowly so that when the heritage
 *     test calls `require('./queries.js')` the resolver returns the key we
 *     already put in cache, instead of attempting disk lookup.
 */
import { Module } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as queriesModule from './src/code-intel/queries.js';

const queriesJsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'src/code-intel/queries.js',
);

// Populate Module._cache so that `require(queriesJsPath)` returns our ESM
// namespace object immediately without hitting the disk.
const m = new Module(queriesJsPath);
m.filename = queriesJsPath;
m.exports = queriesModule;
m.loaded = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._cache[queriesJsPath] = m;

// Narrowly intercept _resolveFilename so that `require('./queries.js')`
// issued from inside the heritage test file resolves to queriesJsPath
// (which is already in cache) instead of failing with ENOENT.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orig = (Module as any)._resolveFilename.bind(Module);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
    if (
        request === './queries.js' &&
        typeof parent?.filename === 'string' &&
        parent.filename.includes('queries.heritage.test')
    ) {
        return queriesJsPath;
    }
    return orig(request, parent, ...rest);
};
