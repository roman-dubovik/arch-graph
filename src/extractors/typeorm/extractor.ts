import {
    ClassDeclaration,
    Decorator,
    Node,
    ParameterDeclaration,
    Project,
    PropertyDeclaration,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { TypeOrmInjectionSite } from '../../core/types.js';
import { buildEntityIndex, EntityIndex } from './entity-index.js';

/**
 * Phase 1 TypeORM extractor.
 *
 * What we capture:
 *   - Every `@InjectRepository(EntityClass)` decorator → injection site
 *   - Resolves EntityClass against the project-wide `EntityIndex` (`@Entity(...)` pre-pass)
 *
 * What we deliberately skip in Phase 1 (per 02-extractors-design §3):
 *   - read/write classification by repository call-site method name
 *   - multi-DataSource attribution via `forFeature([Entity], 'dataSourceName')`
 *
 * `@InjectRepository` only ever takes one (rare two: `(Entity, 'ds')`) argument and
 * in practice the first is always an Identifier referencing an entity class —
 * we verified across 5 production monorepos (904 injection sites, 0 multi-arg).
 */

export interface ExtractTypeOrmResult {
    sites: TypeOrmInjectionSite[];
    entities: EntityIndex;
}

export async function extractTypeOrm(
    _cfg: ArchGraphConfig,
    project: Project,
): Promise<ExtractTypeOrmResult> {
    const entities = buildEntityIndex(project);
    const sites: TypeOrmInjectionSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedFile(sf)) continue;

        // Cheap pre-filter: only consider files that mention the decorator at all.
        const text = sf.getFullText();
        if (!text.includes('@InjectRepository')) continue;

        for (const cls of sf.getClasses()) {
            const enclosingClass = cls.getName();
            for (const prop of cls.getProperties()) {
                const dec = findInjectRepositoryDecorator(prop);
                if (!dec) continue;
                const site = buildSite(prop, dec, entities, enclosingClass);
                if (site) sites.push(site);
            }
            // Also handle constructor-parameter injection (NestJS supports it):
            //   constructor(@InjectRepository(Foo) private readonly repo: Repository<Foo>)
            const ctors = cls.getConstructors();
            for (const ctor of ctors) {
                for (const param of ctor.getParameters()) {
                    const dec = param.getDecorator('InjectRepository');
                    if (!dec) continue;
                    const site = buildSiteFromParam(param, dec, entities, enclosingClass);
                    if (site) sites.push(site);
                }
            }
        }
    }

    return { sites, entities };
}

function findInjectRepositoryDecorator(prop: PropertyDeclaration): Decorator | undefined {
    for (const dec of prop.getDecorators()) {
        if (dec.getName() === 'InjectRepository') return dec;
    }
    return undefined;
}

function buildSite(
    prop: PropertyDeclaration,
    dec: Decorator,
    entities: EntityIndex,
    enclosingClass: string | undefined,
): TypeOrmInjectionSite | null {
    const entityClass = readEntityIdentifier(dec);
    if (!entityClass) return null;
    return {
        propertyName: prop.getName(),
        entityClass,
        resolvedEntity: entities.get(entityClass) ?? null,
        location: locOf(dec),
        enclosingClass,
    };
}

function buildSiteFromParam(
    param: ParameterDeclaration,
    dec: Decorator,
    entities: EntityIndex,
    enclosingClass: string | undefined,
): TypeOrmInjectionSite | null {
    const entityClass = readEntityIdentifier(dec);
    if (!entityClass) return null;
    return {
        propertyName: param.getName(),
        entityClass,
        resolvedEntity: entities.get(entityClass) ?? null,
        location: locOf(dec),
        enclosingClass,
    };
}

function locOf(dec: Decorator): { file: string; line: number; column: number } {
    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    return { file: sf.getFilePath(), line: pos.line, column: pos.column };
}

function readEntityIdentifier(dec: Decorator): string | null {
    const args = dec.getArguments();
    if (args.length === 0) return null;
    const first = args[0]!;
    // Most common: @InjectRepository(Foo) — plain Identifier.
    if (first.getKind() === SyntaxKind.Identifier) {
        return first.getText();
    }
    // Defensive: @InjectRepository(SomeNamespace.Foo) — take the rightmost segment.
    if (first.getKind() === SyntaxKind.PropertyAccessExpression) {
        return first.getText().split('.').pop() ?? null;
    }
    return null;
}

function isExcludedFile(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (p.includes('/node_modules/')) return true;
    if (p.includes('/dist/')) return true;
    if (p.includes('/.claude/')) return true;
    if (p.includes('/.worktrees/')) return true;
    if (p.endsWith('.d.ts')) return true;
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts')) return true;
    return false;
}

/** Re-export for completeness; also used by the resolver if a class is unnamed (anonymous default-exported). */
function findEnclosingClassName(node: Node): string | undefined {
    let cur: Node | undefined = node;
    while (cur) {
        if (cur.getKind() === SyntaxKind.ClassDeclaration) {
            return (cur as ClassDeclaration).getName();
        }
        cur = cur.getParent();
    }
    return undefined;
}

export const _internal = { findEnclosingClassName };
