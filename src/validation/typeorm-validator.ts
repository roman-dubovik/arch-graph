import type { ArchGraphConfig } from '../core/config.js';
import type {
    TypeOrmEntity,
    TypeOrmGroundTruthEntry,
    TypeOrmInjectionSite,
    TypeOrmValidationReport,
} from '../core/types.js';
import { buildLineStarts, indexBy, matchByLineKey, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for TypeORM. Two signals:
 *   - `@InjectRepository(EntityClass[, 'dataSource'])` -> role: 'injection'
 *   - `@Entity('table_name'?)`                          -> role: 'entity'
 * Matched against extracted sites by file:line (same scheme as NATS validator).
 */

// `s` flag = match across newlines so multi-line decorators (`@InjectRepository(\n Foo\n)`)
// aren't invisible to ground truth — those forms exist in real codebases and would
// otherwise let an AST-only extractor match silently with no GT counterpart.
const INJECT_RE = /@InjectRepository\s*\(\s*([A-Za-z_][\w]*)/gs;
const ENTITY_RE = /@Entity\s*\(\s*(?:['"`]([^'"`)]+)['"`])?/gs;

export async function enumerateTypeOrmGroundTruth(
    cfg: ArchGraphConfig,
): Promise<TypeOrmGroundTruthEntry[]> {
    const out: TypeOrmGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'typeorm GT')) {
        if (!content.includes('@InjectRepository') && !content.includes('@Entity')) continue;

        // strip-comments preserves line numbers, so absolute offsets still map to source lines.
        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        const push = (role: 'injection' | 'entity', m: RegExpMatchArray): void => {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(offset, lineStarts);
            out.push({
                role,
                location: { file, line, column },
                matchedText: stripped.slice(offset, offset + 80).replace(/\n.*$/s, '').trim(),
                context: m[1] ?? '',
            });
        };

        for (const m of stripped.matchAll(INJECT_RE)) push('injection', m);
        for (const m of stripped.matchAll(ENTITY_RE)) push('entity', m);
    }

    return out;
}

export function buildTypeOrmReport(
    injections: TypeOrmInjectionSite[],
    entities: TypeOrmEntity[],
    groundTruth: TypeOrmGroundTruthEntry[],
): TypeOrmValidationReport {
    // Cardinality matching: when N decorators land on one line (e.g. compact
    // constructor params), each GT entry consumes one extracted site so partial
    // misses can't hide behind a single matched sibling.
    const injKeyed = indexBy(injections, (s) => `${s.location.file}:${s.location.line}`);
    const entKeyed = indexBy(entities, (e) => `${e.file}:${e.line}`);
    const gtInj = groundTruth.filter((g) => g.role === 'injection');
    const gtEnt = groundTruth.filter((g) => g.role === 'entity');

    const { consumed: consumedInj, missed: missedInjections } = matchByLineKey(gtInj, injKeyed);
    const { consumed: consumedEnt, missed: missedEntities } = matchByLineKey(gtEnt, entKeyed);

    const extraInjections = injections.filter((s) => !consumedInj.has(s));
    const resolvedCount = injections.filter((s) => s.resolvedEntity !== null).length;

    return {
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


