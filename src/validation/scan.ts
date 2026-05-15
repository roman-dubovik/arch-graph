import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';

/**
 * Async generator that yields `{ file, content }` for every TypeScript source
 * file matched by `cfg.appsGlob` / `cfg.libsGlob`, skipping test, declaration,
 * build-output, and excluded files.
 *
 * Shared by all per-domain `enumerate*GroundTruth` functions — previously each
 * copied the same `fg(...)` + `readFile(...)` + ENOENT guard verbatim.
 *
 * @param label  Used only in the error message thrown on unexpected read failures.
 */
export async function* iterateSourceFiles(
    cfg: ArchGraphConfig,
    label: string,
): AsyncGenerator<{ file: string; content: string }> {
    const root = resolve(cfg.root);
    const files = await fg(
        [`${cfg.appsGlob}/**/*.ts`, ...(cfg.libsGlob ? [`${cfg.libsGlob}/**/*.ts`] : [])],
        {
            cwd: root,
            absolute: true,
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/.claude/**',
                '**/.worktrees/**',
                '**/*.spec.ts',
                '**/*.test.ts',
                '**/*.d.ts',
                ...(cfg.excludeGlobs?.map((g) => `**${g}**`) ?? []),
            ],
        },
    );

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`${label} read failed for ${file}: ${e.code ?? e.message}`, { cause: err });
        }
        yield { file, content };
    }
}
