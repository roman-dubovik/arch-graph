import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';
import type { GroundTruthEntry } from '../core/types.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground truth для receiver-сайтов: декораторы @MessagePattern / @EventPattern.
 * Самый точный сигнал — однозначные NATS-маркеры.
 */
export async function enumerateHandlers(cfg: ArchGraphConfig): Promise<GroundTruthEntry[]> {
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

    const decoratorRe = /@(MessagePattern|EventPattern)\s*\(/g;
    const out: GroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`ground-truth read failed for ${file}: ${e.code ?? e.message}`, { cause: err });
        }
        const stripped = stripComments(content);
        const lines = stripped.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.trim().length === 0) continue;
            for (const m of line.matchAll(decoratorRe)) {
                out.push({
                    role: 'receiver',
                    location: { file, line: i + 1, column: (m.index ?? 0) + 1 },
                    matchedText: line.trim(),
                    context: `@${m[1]}`,
                });
            }
        }
    }

    return out;
}
