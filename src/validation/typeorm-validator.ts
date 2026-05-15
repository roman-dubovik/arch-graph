import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig } from '../core/config.js';
import type {
    TypeOrmEntity,
    TypeOrmGroundTruthEntry,
    TypeOrmInjectionSite,
    TypeOrmValidationReport,
} from '../core/types.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for TypeORM.
 *
 * Two signals:
 *  - `@InjectRepository(EntityClass[, 'dataSourceName'])`   → role: 'injection'
 *  - `@Entity('table_name'?)`                                → role: 'entity'
 *
 * The validator then matches extracted call-sites against ground-truth by
 * file:line, exactly like the NATS validator. Recall < 95% trips the regression
 * gate in the CLI build.
 */

const INJECT_RE = /@InjectRepository\(\s*([A-Za-z_][\w]*)/g;
const ENTITY_RE = /@Entity\(\s*(?:['"`]([^'"`)]+)['"`])?/g;

export async function enumerateTypeOrmGroundTruth(
    cfg: ArchGraphConfig,
): Promise<TypeOrmGroundTruthEntry[]> {
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

    const out: TypeOrmGroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch {
            continue;
        }
        // Cheap pre-filter — most files have neither marker.
        if (!content.includes('@InjectRepository') && !content.includes('@Entity')) continue;

        const stripped = stripComments(content);
        const lines = stripped.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.length === 0) continue;

            INJECT_RE.lastIndex = 0;
            for (const m of line.matchAll(INJECT_RE)) {
                out.push({
                    role: 'injection',
                    location: { file, line: i + 1, column: (m.index ?? 0) + 1 },
                    matchedText: line.trim(),
                    context: m[1] ?? '',
                });
            }

            ENTITY_RE.lastIndex = 0;
            for (const m of line.matchAll(ENTITY_RE)) {
                out.push({
                    role: 'entity',
                    location: { file, line: i + 1, column: (m.index ?? 0) + 1 },
                    matchedText: line.trim(),
                    context: m[1] ?? '',
                });
            }
        }
    }

    return out;
}

export function buildTypeOrmReport(
    projectId: string,
    injections: TypeOrmInjectionSite[],
    entities: TypeOrmEntity[],
    groundTruth: TypeOrmGroundTruthEntry[],
): TypeOrmValidationReport {
    const injKeyed = indexBy(injections, locKeyInj);
    const entKeyed = indexBy(entities, locKeyEnt);
    const gtInj = groundTruth.filter((g) => g.role === 'injection');
    const gtEnt = groundTruth.filter((g) => g.role === 'entity');

    const missedInjections: TypeOrmGroundTruthEntry[] = [];
    for (const g of gtInj) {
        const k = `${g.location.file}:${g.location.line}`;
        if (!injKeyed.has(k)) missedInjections.push(g);
    }

    const missedEntities: TypeOrmGroundTruthEntry[] = [];
    for (const g of gtEnt) {
        const k = `${g.location.file}:${g.location.line}`;
        if (!entKeyed.has(k)) missedEntities.push(g);
    }

    const gtInjKeyed = indexBy(gtInj, (g) => `${g.location.file}:${g.location.line}`);
    const extraInjections: TypeOrmInjectionSite[] = [];
    for (const s of injections) {
        const k = locKeyInj(s);
        if (!gtInjKeyed.has(k)) extraInjections.push(s);
    }

    const resolvedCount = injections.filter((s) => s.resolvedEntity !== null).length;

    return {
        projectId,
        timestamp: new Date().toISOString(),
        summary: {
            recallInjections: gtInj.length > 0 ? (gtInj.length - missedInjections.length) / gtInj.length : 1,
            recallEntities: gtEnt.length > 0 ? (gtEnt.length - missedEntities.length) / gtEnt.length : 1,
            resolveRate: injections.length > 0 ? resolvedCount / injections.length : 0,
            totalInjections: injections.length,
            totalEntities: entities.length,
            groundTruthInjections: gtInj.length,
            groundTruthEntities: gtEnt.length,
        },
        injections,
        entities,
        groundTruth,
        missedInjections,
        missedEntities,
        extraInjections,
    };
}

function locKeyInj(s: TypeOrmInjectionSite): string {
    return `${s.location.file}:${s.location.line}`;
}

function locKeyEnt(e: TypeOrmEntity): string {
    return `${e.file}:${e.line}`;
}

function indexBy<T>(arr: T[], keyFn: (t: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const item of arr) {
        const k = keyFn(item);
        const list = m.get(k);
        if (list) list.push(item);
        else m.set(k, [item]);
    }
    return m;
}
