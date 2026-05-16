import {
    ArrowFunction,
    Project,
    SyntaxKind,
} from 'ts-morph';

import type { TypeOrmRelation } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import type { EntityIndex } from './entity-index.js';

const RELATION_DECORATORS = ['ManyToOne', 'OneToMany', 'ManyToMany', 'OneToOne'] as const;
type RelationDecorator = (typeof RELATION_DECORATORS)[number];

/**
 * Walks every source file and extracts relation decorators
 * (`@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`) on properties of
 * known `@Entity` classes. Resolves the type-factory argument `() => Foo` to
 * a target class name, then looks that class up in the entity index.
 *
 * Properties on classes that are NOT indexed entities are silently skipped.
 * Properties in excluded source files are silently skipped.
 */
export function extractRelations(project: Project, entityIndex: EntityIndex): TypeOrmRelation[] {
    const relations: TypeOrmRelation[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;

        const text = sf.getFullText();
        const hasRelationDecorator = RELATION_DECORATORS.some((d) => text.includes(`@${d}`));
        if (!hasRelationDecorator) continue;

        for (const cls of sf.getClasses()) {
            const className = cls.getName();
            if (!className) continue;

            // Only process properties on known @Entity classes
            if (!entityIndex.get(className)) continue;

            for (const prop of cls.getProperties()) {
                for (const decoratorName of RELATION_DECORATORS) {
                    const dec = prop.getDecorator(decoratorName);
                    if (!dec) continue;

                    const propertyName = prop.getName();
                    const { targetClass, resolvedTarget } = resolveTarget(dec, entityIndex, decoratorName);

                    const pos = sf.getLineAndColumnAtPos(dec.getStart());
                    relations.push({
                        decorator: decoratorName,
                        ownerClass: className,
                        propertyName,
                        targetClass,
                        resolvedTarget,
                        location: {
                            file: sf.getFilePath(),
                            line: pos.line,
                            column: pos.column,
                        },
                    });
                }
            }
        }
    }

    return relations;
}

function resolveTarget(
    dec: import('ts-morph').Decorator,
    entityIndex: EntityIndex,
    _decoratorName: RelationDecorator,
): { targetClass: string; resolvedTarget: import('../../core/types.js').TypeOrmEntity | null } {
    const args = dec.getArguments();
    if (args.length === 0) {
        return { targetClass: '', resolvedTarget: null };
    }

    const first = args[0]!;

    // The canonical form: `() => Foo` (ArrowFunction with Identifier body)
    if (first.getKind() === SyntaxKind.ArrowFunction) {
        const arrow = first as ArrowFunction;
        const body = arrow.getBody();
        if (body.getKind() === SyntaxKind.Identifier) {
            const targetClass = body.getText();
            const resolvedTarget = entityIndex.get(targetClass) ?? null;
            return { targetClass, resolvedTarget };
        }
        // Arrow body is not a bare identifier (e.g. property access, call, etc.) — unresolvable
        return { targetClass: '', resolvedTarget: null };
    }

    // String literal, Identifier, or any other form — unresolvable
    return { targetClass: '', resolvedTarget: null };
}
