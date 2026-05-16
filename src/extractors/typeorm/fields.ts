/**
 * TypeORM entity field extractor — Variant 2, Task B4.
 *
 * Walks `@Entity`-decorated classes and collects `@Column*` decorated properties.
 * Accepted decorators:
 *   @Column, @PrimaryColumn, @PrimaryGeneratedColumn,
 *   @CreateDateColumn, @UpdateDateColumn, @DeleteDateColumn
 *
 * Field meta:
 *   - fieldName: property name on the class
 *   - fieldType: string from decorator arg or TypeScript type (fallback to TS type)
 *   - nullable: true if decorator opts include { nullable: true }
 *
 * Inheritance (P0-3): properties declared on abstract base classes are collected
 * by walking the base-class chain via getBaseClass(). A cycle guard prevents
 * infinite loops on malformed/partial ASTs.
 */

import {
    ClassDeclaration,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    PropertyDeclaration,
    SyntaxKind,
} from 'ts-morph';
import type { SourceLoc, TypeOrmEntity } from '../../core/types.js';
import { tableNameOf } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

/** Column decorator names recognised by the field extractor. */
export type ColumnDecorator =
    | 'Column'
    | 'PrimaryColumn'
    | 'PrimaryGeneratedColumn'
    | 'CreateDateColumn'
    | 'UpdateDateColumn'
    | 'DeleteDateColumn';

export interface EntityFieldSite {
    /** Parent entity class name (concrete @Entity class, even for inherited fields). */
    entityClass: string;
    /** Parent table name. */
    tableName: string;
    /** Decorator used (for meta). */
    decorator: ColumnDecorator;
    /** Field property name. */
    fieldName: string;
    /** SQL column type (string). */
    fieldType: string;
    /** Is the column nullable. */
    nullable: boolean;
    /** Source location (file + line where the decorator lives). */
    location: SourceLoc;
}

export interface DbEntityFieldExtractResult {
    fields: EntityFieldSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

const FIELD_DECORATORS = new Set<string>([
    'Column',
    'PrimaryColumn',
    'PrimaryGeneratedColumn',
    'CreateDateColumn',
    'UpdateDateColumn',
    'DeleteDateColumn',
]);

function isColumnDecorator(name: string): name is ColumnDecorator {
    return FIELD_DECORATORS.has(name);
}

/**
 * Extract type string from decorator arguments.
 * Handles:
 *   @Column('varchar')                   → 'varchar'
 *   @Column({ type: 'varchar' })         → 'varchar'
 *   @Column('text', { nullable: true })  → 'text'
 *   @PrimaryGeneratedColumn('uuid')      → 'uuid'
 *   @PrimaryGeneratedColumn()            → 'int' (default)
 *   @CreateDateColumn / @UpdateDateColumn / @DeleteDateColumn → 'timestamp'
 */
function resolveFieldType(
    decoratorName: ColumnDecorator,
    args: ReturnType<import('ts-morph').Decorator['getArguments']>,
    tsMorphPropType: string,
): string {
    // Date columns always produce timestamp
    if (
        decoratorName === 'CreateDateColumn' ||
        decoratorName === 'UpdateDateColumn' ||
        decoratorName === 'DeleteDateColumn'
    ) {
        return 'timestamp';
    }

    // PrimaryGeneratedColumn() default
    if (decoratorName === 'PrimaryGeneratedColumn' && args.length === 0) {
        return 'int';
    }

    for (const arg of args) {
        // String literal first arg: @Column('varchar') or @PrimaryGeneratedColumn('uuid')
        if (
            arg.getKind() === SyntaxKind.StringLiteral ||
            arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
            return (arg as unknown as { getLiteralText(): string }).getLiteralText();
        }

        // Object literal: @Column({ type: 'varchar', ... })
        if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const obj = arg as ObjectLiteralExpression;
            for (const prop of obj.getProperties()) {
                if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
                const pa = prop as PropertyAssignment;
                if (pa.getName() !== 'type') continue;
                const init = pa.getInitializer();
                if (!init) continue;
                if (
                    init.getKind() === SyntaxKind.StringLiteral ||
                    init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
                ) {
                    return (init as unknown as { getLiteralText(): string }).getLiteralText();
                }
            }
        }
    }

    // Fallback: TS property type text (simplified)
    return tsMorphPropType || 'unknown';
}

/**
 * Resolve nullable from decorator arguments.
 * Returns true if any object-literal arg has `nullable: true`.
 */
function resolveNullable(
    args: ReturnType<import('ts-morph').Decorator['getArguments']>,
): boolean {
    for (const arg of args) {
        if (arg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
        const obj = arg as ObjectLiteralExpression;
        for (const prop of obj.getProperties()) {
            if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
            const pa = prop as PropertyAssignment;
            if (pa.getName() !== 'nullable') continue;
            const init = pa.getInitializer();
            if (!init) continue;
            return init.getKind() === SyntaxKind.TrueKeyword;
        }
    }
    return false;
}

/**
 * Get a simplified TS type string from a property declaration.
 * Strips nullability union for cleaner display.
 */
function getTsTypeText(prop: PropertyDeclaration): string {
    const typeNode = prop.getTypeNode();
    if (!typeNode) return 'unknown';
    const txt = typeNode.getText();
    // Strip common null unions: 'string | null' → 'string'
    return txt.replace(/\s*\|\s*null\s*$/, '').replace(/^\s*null\s*\|\s*/, '').trim();
}

/**
 * Recursively collect all property declarations from `cls` and its base class
 * hierarchy. Concrete class properties come first; base-class properties follow.
 *
 * A `seen` Set guards against degenerate circular base-class chains (should be
 * unreachable in valid TypeScript but can occur with partial/malformed ASTs).
 * Returns `{ props, cycles }` so callers can accumulate the cycle count.
 */
export function getAllFieldProperties(
    cls: ClassDeclaration,
    seen = new Set<ClassDeclaration>(),
): { props: PropertyDeclaration[]; cycles: number } {
    if (seen.has(cls)) {
        process.stderr.write(
            `[typeorm/fields] BUG: circular base class chain at ${cls.getName?.() ?? '<anon>'}; truncating.\n`,
        );
        return { props: [], cycles: 1 };
    }
    seen.add(cls);
    const base = cls.getBaseClass();
    if (!base) return { props: cls.getProperties(), cycles: 0 };
    const sub = getAllFieldProperties(base, seen);
    return { props: [...cls.getProperties(), ...sub.props], cycles: sub.cycles };
}

/**
 * Extract db-entity-field sites from a ts-morph Project, using the provided
 * entity index (list of @Entity-decorated classes with their table names).
 *
 * The project is needed to walk source files and find the actual class declarations.
 * Inherited @Column properties from abstract base classes are included via the
 * base-class chain walk.
 */
export function extractEntityFields(
    entities: TypeOrmEntity[],
    project?: Project,
): DbEntityFieldExtractResult {
    const fields: EntityFieldSite[] = [];
    const diagnostics: Array<{ file: string; line: number; message: string }> = [];

    if (entities.length === 0) return { fields, diagnostics };

    // Build lookup: className → TypeOrmEntity
    const entityByClass = new Map<string, TypeOrmEntity>();
    for (const e of entities) {
        entityByClass.set(e.className, e);
    }

    // If project is provided, walk source files
    const sourceFiles = project
        ? project.getSourceFiles().filter((sf) => !isExcludedSourceFile(sf))
        : [];

    for (const sf of sourceFiles) {
        if (!sf.getFullText().includes('@Entity')) continue;
        const filePath = sf.getFilePath();

        for (const cls of sf.getClasses()) {
            const entityDec = cls.getDecorator('Entity');
            if (!entityDec) continue;

            const className = cls.getName();
            if (!className) continue;

            const entity = entityByClass.get(className);
            if (!entity) {
                // @Entity class found in source but not in our entity index
                // (e.g. built with warnings-only or non-static arg)
                const loc = sf.getLineAndColumnAtPos(entityDec.getStart());
                diagnostics.push({
                    file: filePath,
                    line: loc.line,
                    message: `@Entity class ${className} not in entity index — fields skipped`,
                });
                continue;
            }

            const tableName = tableNameOf(entity);

            // Walk own + inherited properties via base-class chain
            const { props } = getAllFieldProperties(cls);

            for (const prop of props) {
                for (const dec of prop.getDecorators()) {
                    const decName = dec.getName();
                    if (!isColumnDecorator(decName)) continue;

                    const propName = prop.getName();
                    const tsType = getTsTypeText(prop);

                    const fieldType = resolveFieldType(decName, dec.getArguments(), tsType);
                    const nullable = resolveNullable(dec.getArguments());

                    // Location: use the decorator's own source file (base-class props
                    // live in a different file than the entity source file)
                    const decSf = dec.getSourceFile();
                    const pos = decSf.getLineAndColumnAtPos(dec.getStart());

                    fields.push({
                        entityClass: className,
                        tableName,
                        decorator: decName,
                        fieldName: propName,
                        fieldType,
                        nullable,
                        location: {
                            file: decSf.getFilePath(),
                            line: pos.line,
                            column: pos.column,
                        },
                    });

                    // Only process first matching field decorator per property
                    break;
                }
            }
        }
    }

    return { fields, diagnostics };
}
