import {
    Decorator,
    ExportDeclaration,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SyntaxKind,
} from 'ts-morph';

import type { TypeOrmEntity, TypeOrmEntityDecoratorWarning } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';

export { isExcludedSourceFile };

/**
 * Pre-pass indexer: scans the project for `@Entity(...)` class declarations and
 * resolves them to a `{className, table}` mapping. Mirrors the NATS ConstantIndex.
 *
 * Table-name resolution priority:
 *   1. `@Entity('explicit_name')`                -> explicit_name             (explicit)
 *   2. `@Entity({ name: 'foo', schema: 'bar' })` -> bar.foo                   (explicit)
 *   3. `@Entity()` with no arg                   -> snake_case(ClassName)     (inferred — TypeORM default)
 *   4. `@Entity({ schema: 'public' })` (no name) -> snake_case(ClassName) + WARN (likely a developer typo)
 *   5. `@Entity(NON_STATIC_ARG)`                 -> warning, NOT indexed       (Identifier / Call — extractor can't resolve)
 */

export class EntityIndex {
    private byClass = new Map<string, TypeOrmEntity>();
    readonly warnings: TypeOrmEntityDecoratorWarning[] = [];

    get(className: string): TypeOrmEntity | undefined {
        return this.byClass.get(className);
    }
    size(): number {
        return this.byClass.size;
    }
    entries(): TypeOrmEntity[] {
        return [...this.byClass.values()];
    }
    set(className: string, entity: TypeOrmEntity): void {
        this.byClass.set(className, entity);
    }
}

export function buildEntityIndex(project: Project): EntityIndex {
    const idx = new EntityIndex();

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        if (!sf.getFullText().includes('@Entity')) continue;

        for (const cls of sf.getClasses()) {
            const decorator = cls.getDecorator('Entity');
            if (!decorator) continue;
            const className = cls.getName();
            if (!className) continue;

            const resolution = resolveTableName(decorator, className);
            const line = decorator.getStartLineNumber();
            const file = sf.getFilePath();

            if (resolution.kind === 'non-static') {
                // Don't index — `@InjectRepository(Foo)` for this class lands in
                // `diagnostics.unresolvedEntities` (right bucket; we never knew the table).
                idx.warnings.push({ className, file, line, reason: 'non-static-argument', argKind: resolution.argKind });
                continue;
            }
            if (resolution.kind === 'inferred-object-no-name') {
                idx.warnings.push({ className, file, line, reason: 'object-literal-missing-name' });
            }
            idx.set(className, {
                className,
                tableSource: { kind: resolution.kind, table: resolution.table },
                file,
                line,
            });
        }
    }

    // Second pass: register `export { X as Y }` re-export aliases so
    // `@InjectRepository(EmailSuppression)` resolves to the underlying
    // NotificationSuppression entity even when imported via barrel re-exports.
    registerExportAliases(project, idx);

    return idx;
}

function registerExportAliases(project: Project, idx: EntityIndex): void {
    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        const text = sf.getFullText();
        if (!text.includes('export {') && !text.includes('export{')) continue;
        for (const exp of sf.getExportDeclarations()) {
            collectAliases(exp, idx);
        }
    }
}

function collectAliases(exp: ExportDeclaration, idx: EntityIndex): void {
    for (const spec of exp.getNamedExports()) {
        const alias = spec.getAliasNode();
        if (!alias) continue;
        const sourceName = spec.getNameNode().getText();
        const aliasName = alias.getText();
        if (idx.get(aliasName)) continue;
        const target = idx.get(sourceName);
        if (target) idx.set(aliasName, target);
    }
}

type Resolution =
    | { kind: 'explicit'; table: string }
    | { kind: 'inferred-no-arg'; table: string }
    | { kind: 'inferred-object-no-name'; table: string }
    | { kind: 'non-static'; argKind: string };

function resolveTableName(decorator: Decorator, className: string): Resolution {
    const args = decorator.getArguments();
    if (args.length === 0) {
        return { kind: 'inferred-no-arg', table: snakeCase(className) };
    }

    const first = args[0]!;
    if (
        first.getKind() === SyntaxKind.StringLiteral ||
        first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        const lit = (first as unknown as { getLiteralText: () => string }).getLiteralText();
        return { kind: 'explicit', table: lit };
    }

    if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = first as ObjectLiteralExpression;
        let name: string | undefined;
        let schema: string | undefined;
        for (const prop of obj.getProperties()) {
            if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
            const pa = prop as PropertyAssignment;
            const init = pa.getInitializer();
            if (!init) continue;
            const kind = init.getKind();
            if (
                kind !== SyntaxKind.StringLiteral &&
                kind !== SyntaxKind.NoSubstitutionTemplateLiteral
            ) continue;
            const lit = (init as unknown as { getLiteralText: () => string }).getLiteralText();
            const propName = pa.getName();
            if (propName === 'name') name = lit;
            else if (propName === 'schema') schema = lit;
        }
        if (name) {
            return { kind: 'explicit', table: schema ? `${schema}.${name}` : name };
        }
        return { kind: 'inferred-object-no-name', table: snakeCase(className) };
    }

    return { kind: 'non-static', argKind: first.getKindName() };
}

/**
 * Matches `typeorm/util/StringUtils.snakeCase`:
 *   lowerCase Boundary -> lower_case_boundary
 *   UPPERCase boundary -> uppercase_boundary (consecutive caps collapse)
 */
function snakeCase(s: string): string {
    return s
        .replace(/([a-z\d])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}

