import {
    Decorator,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { TypeOrmEntity } from '../../core/types.js';

/**
 * Pre-pass indexer: scans the project for `@Entity(...)` class declarations and
 * resolves them to a `{className, table}` mapping. Mirrors the NATS ConstantIndex.
 *
 * Table-name resolution priority:
 *   1. `@Entity('explicit_name')`               -> explicit_name
 *   2. `@Entity({ name: 'foo', schema: 'bar' })` -> bar.foo (or foo if no schema)
 *   3. `@Entity()` with no arg                   -> snake_case(ClassName)
 */
export class EntityIndex {
    private byClass = new Map<string, TypeOrmEntity>();

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
        if (isExcludedForIndex(sf)) continue;
        if (!sf.getFullText().includes('@Entity')) continue;

        for (const cls of sf.getClasses()) {
            const decorator = cls.getDecorator('Entity');
            if (!decorator) continue;
            const className = cls.getName();
            if (!className) continue;

            const { table, inferred } = resolveTableName(decorator, className);
            idx.set(className, {
                className,
                table,
                inferredTable: inferred,
                file: sf.getFilePath(),
                line: decorator.getStartLineNumber(),
            });
        }
    }

    return idx;
}

function resolveTableName(
    decorator: Decorator,
    className: string,
): { table: string; inferred: boolean } {
    const args = decorator.getArguments();
    if (args.length === 0) {
        return { table: snakeCase(className), inferred: true };
    }

    const first = args[0]!;
    if (
        first.getKind() === SyntaxKind.StringLiteral ||
        first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        const lit = (first as unknown as { getLiteralText: () => string }).getLiteralText();
        return { table: lit, inferred: false };
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
            return { table: schema ? `${schema}.${name}` : name, inferred: false };
        }
        return { table: snakeCase(className), inferred: true };
    }

    return { table: snakeCase(className), inferred: true };
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

function isExcludedForIndex(sf: SourceFile): boolean {
    const p = sf.getFilePath();
    if (p.includes('/node_modules/')) return true;
    if (p.includes('/dist/')) return true;
    if (p.includes('/.claude/')) return true;
    if (p.includes('/.worktrees/')) return true;
    if (p.endsWith('.d.ts')) return true;
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts')) return true;
    return false;
}
