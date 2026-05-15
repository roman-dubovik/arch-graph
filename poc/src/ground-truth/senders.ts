import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { GroundTruthEntry, ProjectConfig } from '../types.js';

/**
 * Ground truth для sender-сайтов.
 *
 * Стратегия: файл считается NATS-sender файлом если он импортирует ClientProxy
 * из '@nestjs/microservices' ИЛИ один из wrapper-классов из конфига.
 * Тогда мы ищем `.send/.emit/.publish/.request(`, привязанные к этим типам.
 */
export async function enumerateSenders(cfg: ProjectConfig): Promise<GroundTruthEntry[]> {
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

    const natsTypes = new Set<string>([
        'ClientProxy',
        'ClientNats',
        ...cfg.wrapperPublishApis.map((a) => a.class),
    ]);
    const natsMethods = new Set(['send', 'emit', 'publish', 'request']);
    for (const api of cfg.wrapperPublishApis) {
        for (const m of api.methods) natsMethods.add(m);
    }

    const importNestjsMicroservices = /from\s+['"]@nestjs\/microservices['"]/;
    const out: GroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch {
            continue;
        }

        const hasNestMs = importNestjsMicroservices.test(content);
        const hasWrapperImport = cfg.wrapperPublishApis.some((api) =>
            new RegExp(`\\b${escapeReg(api.class)}\\b`).test(content),
        );
        if (!hasNestMs && !hasWrapperImport) continue;

        const idToType = new Map<string, string>();

        for (const typeName of natsTypes) {
            // property/constructor-param form: `(private|readonly|protected|public) [readonly] <id>: <Type>`
            const re1 = new RegExp(
                `(?:private|readonly|public|protected)\\s+(?:readonly\\s+)?(\\w+)\\s*:\\s*${escapeReg(typeName)}\\b`,
                'g',
            );
            for (const m of content.matchAll(re1)) {
                idToType.set(m[1]!, typeName);
            }
            // local variable form
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
            // skip lines that are now empty (were full-line comments)
            if (line.trim().length === 0) continue;
            for (const [id, typeName] of idToType) {
                // this.<id>.<method>(
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

                // local form (not this.X)
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

/**
 * Replaces single-line // and multi-line block comments with whitespace,
 * preserving line numbers so reporting remains accurate.
 */
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
            // single-line comment — replace with spaces until newline
            while (i < n && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && next === '*') {
            // block comment — replace with spaces & keep newlines
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            i += 2; // skip closing */
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
