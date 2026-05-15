import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';
import type { GroundTruthEntry } from '../core/types.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground truth для sender-сайтов.
 *
 * Файл — NATS-sender, если импортирует ClientProxy из '@nestjs/microservices'
 * или один из wrapper-классов из конфига. Затем grep .send/.emit/.publish/.request(.
 */
export async function enumerateSenders(cfg: ArchGraphConfig): Promise<GroundTruthEntry[]> {
    const root = resolve(cfg.root);
    const wrappers = cfg.nats?.wrapperPublishApis ?? [];

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

    const natsTypes = new Set<string>(['ClientProxy', 'ClientNats', ...wrappers.map((a) => a.class)]);
    const natsMethods = new Set(['send', 'emit', 'publish', 'request']);
    for (const api of wrappers) {
        for (const m of api.methods) natsMethods.add(m);
    }

    const importNestjsMicroservices = /from\s+['"]@nestjs\/microservices['"]/;
    const out: GroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`ground-truth read failed for ${file}: ${e.code ?? e.message}`);
        }

        const hasNestMs = importNestjsMicroservices.test(content);
        const hasWrapperImport = wrappers.some((api) =>
            new RegExp(`\\b${escapeReg(api.class)}\\b`).test(content),
        );
        if (!hasNestMs && !hasWrapperImport) continue;

        const idToType = new Map<string, string>();

        for (const typeName of natsTypes) {
            // Accept any sequence of decorators (`@Inject() @Optional()`) before the access modifier,
            // and allow the modifier itself to be absent when decorators are present
            // (NestJS DI doesn't require `private` on @Inject-prefixed properties).
            const decorPrefix = `(?:@[A-Za-z_][\\w]*\\s*(?:\\([^)]*\\))?\\s*)*`;
            const re1 = new RegExp(
                `${decorPrefix}(?:(?:private|readonly|public|protected)\\s+)+(?:readonly\\s+)?(\\w+)\\s*:\\s*${escapeReg(typeName)}\\b`,
                'g',
            );
            for (const m of content.matchAll(re1)) {
                idToType.set(m[1]!, typeName);
            }
            // Decorator-only properties without explicit access modifier.
            const re1b = new RegExp(
                `(?:@[A-Za-z_][\\w]*\\s*(?:\\([^)]*\\))?\\s*)+(?:readonly\\s+)?(\\w+)\\s*:\\s*${escapeReg(typeName)}\\b`,
                'g',
            );
            for (const m of content.matchAll(re1b)) {
                idToType.set(m[1]!, typeName);
            }
            const re2 = new RegExp(
                `(?:const|let|var)\\s+(\\w+)\\s*:\\s*${escapeReg(typeName)}\\b`,
                'g',
            );
            for (const m of content.matchAll(re2)) {
                idToType.set(m[1]!, typeName);
            }
        }

        if (idToType.size === 0) continue;

        const codeContent = stripComments(content);
        const lines = codeContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.trim().length === 0) continue;
            for (const [id, typeName] of idToType) {
                const re = new RegExp(`\\bthis\\.${escapeReg(id)}\\.(\\w+)\\s*\\(`, 'g');
                for (const m of line.matchAll(re)) {
                    const method = m[1]!;
                    if (!natsMethods.has(method)) continue;
                    out.push({
                        role: 'sender',
                        location: { file, line: i + 1, column: (m.index ?? 0) + 1 },
                        matchedText: line.trim(),
                        context: `${typeName}.${method}`,
                    });
                }

                const re2 = new RegExp(`(?<!\\.)\\b${escapeReg(id)}\\.(\\w+)\\s*\\(`, 'g');
                for (const m of line.matchAll(re2)) {
                    const method = m[1]!;
                    if (!natsMethods.has(method)) continue;
                    const idx = m.index ?? 0;
                    if (idx >= 5 && line.slice(idx - 5, idx) === 'this.') continue;
                    out.push({
                        role: 'sender',
                        location: { file, line: i + 1, column: idx + 1 },
                        matchedText: line.trim(),
                        context: `${typeName}.${method}`,
                    });
                }
            }
        }
    }

    return out;
}

function escapeReg(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
