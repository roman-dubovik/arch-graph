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
 */

import {
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SyntaxKind,
} from 'ts-morph';
import type { TypeOrmEntity } from '../../core/types.js';
import { tableNameOf } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

export interface EntityFieldSite {
    /** Parent entity class name. */
    entityClass: string;
    /** Parent table name. */
    tableName: string;
    /** Decorator used (for meta). */
    decorator: string;
    /** Field property name. */
    fieldName: string;
    /** SQL column type (string). */
    fieldType: string;
    /** Is the column nullable. */
    nullable: boolean;
    /** Source location. */
    file: string;
    line: number;
}

export interface DbEntityFieldExtractResult {
    fields: EntityFieldSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

const FIELD_DECORATORS = new Set([
    'Column',
    'PrimaryColumn',
    'PrimaryGeneratedColumn',
    'CreateDateColumn',
    'UpdateDateColumn',
    'DeleteDateColumn',
]);

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
    decoratorName: string,
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
function getTsTypeText(prop: import('ts-morph').PropertyDeclaration): string {
    const typeNode = prop.getTypeNode();
    if (!typeNode) return 'unknown';
    const txt = typeNode.getText();
    // Strip common null unions: 'string | null' → 'string'
    return txt.replace(/\s*\|\s*null\s*$/, '').replace(/^\s*null\s*\|\s*/, '').trim();
}

/**
 * Extract db-entity-field sites from a ts-morph Project, using the provided
 * entity index (list of @Entity-decorated classes with their table names).
 *
 * The project is needed to walk source files and find the actual class declarations.
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
            if (!entity) continue; // not in our index (e.g. warnings-only entity)

            const tableName = tableNameOf(entity);

            for (const prop of cls.getProperties()) {
                for (const dec of prop.getDecorators()) {
                    const decName = dec.getName();
                    if (!FIELD_DECORATORS.has(decName)) continue;

                    const propName = prop.getName();
                    const tsType = getTsTypeText(prop);

                    const fieldType = resolveFieldType(decName, dec.getArguments(), tsType);
                    const nullable = resolveNullable(dec.getArguments());

                    fields.push({
                        entityClass: className,
                        tableName,
                        decorator: decName,
                        fieldName: propName,
                        fieldType,
                        nullable,
                        file: filePath,
                        line: dec.getStartLineNumber(),
                    });

                    // Only process first matching field decorator per property
                    break;
                }
            }
        }
    }

    return { fields, diagnostics };
}
