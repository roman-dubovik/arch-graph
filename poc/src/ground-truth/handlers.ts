import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { GroundTruthEntry, ProjectConfig } from '../types.js';

/**
 * Ground truth для receiver-сайтов: декораторы @MessagePattern / @EventPattern.
 * Это самый точный сигнал — почти без шума.
 */
export async function enumerateHandlers(cfg: ProjectConfig): Promise<GroundTruthEntry[]> {
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
                ...(cfg.excludeGlobs ?? []),
            ],
        },
    );

    const decoratorRe = /@(MessagePattern|EventPattern)\s*\(/g;
    const out: GroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch {
            continue;
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

function stripComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    let inString: '"' | "'" | '`' | null = null;
    while (i < n) {
        const c = src[i]!;
        const next = src[i + 1];
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < n) {
                out += src[i + 1]!;
                i += 2;
                continue;
            }
            if (c === inString) inString = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            inString = c as '"' | "'" | '`';
            out += c;
            i++;
            continue;
        }
        if (c === '/' && next === '/') {
            while (i < n && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
