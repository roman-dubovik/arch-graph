import {
    Decorator,
    Project,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { TypeOrmInjectionSite } from '../../core/types.js';
import { buildEntityIndex, EntityIndex, isExcludedSourceFile } from './entity-index.js';

/**
 * TypeORM extractor: `@InjectRepository(EntityClass)` (property + ctor-param)
 * resolved against the `@Entity` pre-pass index.
 *
 * Skipped: read/write classification, multi-DataSource attribution
 * (`forFeature([...], 'dataSourceName')`) — both need runtime info AST lacks.
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
        if (isExcludedSourceFile(sf)) continue;
        if (!sf.getFullText().includes('@InjectRepository')) continue;

        for (const cls of sf.getClasses()) {
            const enclosingClass = cls.getName();

            for (const prop of cls.getProperties()) {
                const dec = prop.getDecorator('InjectRepository');
                if (!dec) continue;
                const site = buildSite(prop.getName(), dec, entities, enclosingClass);
                if (site) sites.push(site);
            }

            for (const ctor of cls.getConstructors()) {
                for (const param of ctor.getParameters()) {
                    const dec = param.getDecorator('InjectRepository');
                    if (!dec) continue;
                    const site = buildSite(param.getName(), dec, entities, enclosingClass);
                    if (site) sites.push(site);
                }
            }
        }
    }

    return { sites, entities };
}

function buildSite(
    propertyName: string,
    dec: Decorator,
    entities: EntityIndex,
    enclosingClass: string | undefined,
): TypeOrmInjectionSite | null {
    const entityClass = readEntityIdentifier(dec);
    if (!entityClass) return null;
    const sf = dec.getSourceFile();
    const pos = sf.getLineAndColumnAtPos(dec.getStart());
    return {
        propertyName,
        entityClass,
        resolvedEntity: entities.get(entityClass) ?? null,
        location: { file: sf.getFilePath(), line: pos.line, column: pos.column },
        enclosingClass,
    };
}

function readEntityIdentifier(dec: Decorator): string | null {
    const args = dec.getArguments();
    if (args.length === 0) return null;
    const first = args[0]!;
    if (first.getKind() === SyntaxKind.Identifier) {
        return first.getText();
    }
    if (first.getKind() === SyntaxKind.PropertyAccessExpression) {
        return first.getText().split('.').pop() ?? null;
    }
    return null;
}
