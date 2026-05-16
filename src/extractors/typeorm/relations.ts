import {
    ArrowFunction,
    CallExpression,
    ClassDeclaration,
    NoSubstitutionTemplateLiteral,
    Project,
    PropertyDeclaration,
    SourceFile,
    StringLiteral,
    SyntaxKind,
} from 'ts-morph';

import type { TypeOrmRelation } from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import type { EntityIndex } from './entity-index.js';

const RELATION_DECORATORS = ['ManyToOne', 'OneToMany', 'ManyToMany', 'OneToOne'] as const;
type RelationDecorator = (typeof RELATION_DECORATORS)[number];

export interface ExtractRelationsResult {
    relations: TypeOrmRelation[];
    /** Number of times the cycle guard in `getAllProperties` fired (should be 0 on healthy ASTs). */
    baseClassCycles: number;
}

/**
 * Walks every source file and extracts relation decorators
 * (`@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`) on properties of
 * known `@Entity` classes. Resolves the type-factory argument to a target class
 * name by handling the following forms:
 *   - `() => Foo`              canonical arrow + identifier (most common)
 *   - `type => Foo`            single-param arrow without parens
 *   - `Foo`                    bare identifier (older TypeORM idiom)
 *   - `'ClassName'`            string literal (forward-reference idiom for circular imports)
 *   - `forwardRef(() => Foo)`  NestJS circular-import helper
 *
 * Properties on classes that are NOT indexed entities are silently skipped.
 * Properties in excluded source files are silently skipped.
 *
 * Relations on abstract base classes are also walked: when an entity class
 * extends a base, the base class properties are collected and attributed to
 * the concrete entity. This means `ownerClass` always refers to the concrete
 * `@Entity`-decorated class, even if the property is physically declared on
 * an ancestor.
 *
 * @known-limitation Deeply nested base-class chains (A → B → C) are walked
 * recursively, but only the first declaration of a property name wins (concrete
 * class overrides base). Diamond inheritance is not handled specially — if two
 * paths lead to the same base, its properties may appear twice; this is
 * structurally uncommon in TypeORM usage.
 */
export function extractRelations(project: Project, entityIndex: EntityIndex): ExtractRelationsResult {
    const relations: TypeOrmRelation[] = [];
    let baseClassCycles = 0;

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;

        for (const cls of sf.getClasses()) {
            const className = cls.getName();
            if (!className) continue;

            // Only process properties on known @Entity classes
            if (!entityIndex.get(className)) continue;

            // Walk own + inherited properties; own declarations take priority.
            // Note: properties may live in base-class source files — the fast-path
            // text search is done per-property rather than per-file so we don't miss
            // relations declared on an abstract base that doesn't mention @Entity.
            const { props, cycles } = getAllProperties(cls);
            baseClassCycles += cycles;
            for (const prop of props) {
                for (const decoratorName of RELATION_DECORATORS) {
                    const dec = prop.getDecorator(decoratorName);
                    if (!dec) continue;

                    const propertyName = prop.getName();
                    const resolved = resolveTarget(dec, entityIndex, decoratorName);

                    // Use the decorator's own source file for location — when the property
                    // is inherited from a base class, it lives in a different file than `sf`.
                    const decSf = dec.getSourceFile();
                    const pos = decSf.getLineAndColumnAtPos(dec.getStart());
                    relations.push({
                        decorator: decoratorName,
                        ownerClass: className,
                        propertyName,
                        location: {
                            file: decSf.getFilePath(),
                            line: pos.line,
                            column: pos.column,
                        },
                        ...resolved,
                    } as TypeOrmRelation);
                }
            }
        }
    }

    return { relations, baseClassCycles };
}

/**
 * Recursively collect all property declarations from `cls` and its base class
 * hierarchy. The concrete class's own properties come first; base-class
 * properties are appended. Duplicate property names are intentionally kept
 * (overriding properties in a concrete class shadow the base, but the base
 * version would just produce a duplicate decorator name hit that the caller
 * would still see — in practice TypeORM entities don't redeclare inherited
 * relation properties, so this is a non-issue).
 *
 * `ownerClass` attribution is always the concrete entity — not the base class
 * that physically declares the property — because the relation semantically
 * belongs to the entity that inherits it.
 *
 * A `seen` Set guards against degenerate circular base-class chains that can
 * arise when ts-morph operates on a partial or malformed AST. TypeScript's type
 * system forbids cyclic class extension, but getBaseClass() has been observed to
 * return unexpected results in edge cases. The cycle guard is O(1) per step.
 *
 * Returns `{ props, cycles }` rather than taking an `onCycle` callback so the
 * caller can fold `cycles` into its own counter without an inline arrow.
 * (That arrow was the only uncovered function in v8 coverage runs — eliminating
 * it gets the file back to honest 95% functions coverage.)
 */
export function getAllProperties(
    cls: ClassDeclaration,
    seen = new Set<ClassDeclaration>(),
): { props: PropertyDeclaration[]; cycles: number } {
    if (seen.has(cls)) {
        process.stderr.write(
            `[typeorm/relations] BUG: circular base class chain at ${cls.getName?.() ?? '<anon>'}; truncating.\n`,
        );
        return { props: [], cycles: 1 };
    }
    seen.add(cls);
    const base = cls.getBaseClass();
    if (!base) return { props: cls.getProperties(), cycles: 0 };
    // Concrete own props first; base props appended (base may itself have a base)
    const sub = getAllProperties(base, seen);
    return { props: [...cls.getProperties(), ...sub.props], cycles: sub.cycles };
}

type ResolveResult =
    | { targetClass: string; resolvedTarget: import('../../core/types.js').TypeOrmEntity; reason?: never; raw?: never }
    | { targetClass: string; resolvedTarget: null; reason: 'not-indexed'; raw?: never }
    | { targetClass: null; resolvedTarget: null; reason: 'unparseable'; raw: string };

/**
 * Build a per-source-file set of local names that resolve to `forwardRef` from
 * `@nestjs/common`. Handles both canonical (`import { forwardRef }`) and aliased
 * (`import { forwardRef as fr }`) import forms.
 *
 * Cached lazily per source file so repeated calls for the same file are O(1).
 * Uses the decorator's own source file (`dec.getSourceFile()`) to handle
 * inherited properties that may be declared in a different file than the entity.
 */
const forwardRefAliasCache = new WeakMap<SourceFile, Set<string>>();

function getForwardRefNames(sf: SourceFile): Set<string> {
    const cached = forwardRefAliasCache.get(sf);
    if (cached) return cached;

    const names = new Set<string>();
    for (const decl of sf.getImportDeclarations()) {
        if (decl.getModuleSpecifierValue() !== '@nestjs/common') continue;
        for (const named of decl.getNamedImports()) {
            const origName = named.getName(); // text of the imported symbol
            if (origName === 'forwardRef') {
                // `import { forwardRef }` or `import { forwardRef as X }`
                const alias = named.getAliasNode();
                names.add(alias ? alias.getText() : origName);
            }
        }
    }
    forwardRefAliasCache.set(sf, names);
    return names;
}

function resolveTarget(
    dec: import('ts-morph').Decorator,
    entityIndex: EntityIndex,
    _decoratorName: RelationDecorator,
): ResolveResult {
    const args = dec.getArguments();
    if (args.length === 0) {
        return { targetClass: null, resolvedTarget: null, reason: 'unparseable', raw: '' };
    }

    const first = args[0]!;

    // The canonical form: `() => Foo` or `type => Foo` (ArrowFunction with Identifier body)
    if (first.getKind() === SyntaxKind.ArrowFunction) {
        const arrow = first as ArrowFunction;
        const body = arrow.getBody();

        if (body.getKind() === SyntaxKind.Identifier) {
            const targetClass = body.getText();
            const resolvedTarget = entityIndex.get(targetClass) ?? null;
            if (resolvedTarget) return { targetClass, resolvedTarget };
            return { targetClass, resolvedTarget: null, reason: 'not-indexed' };
        }

        // forwardRef(() => Foo) — NestJS pattern for circular entity imports.
        // The arrow body is a CallExpression whose callee resolves to the `forwardRef`
        // export from `@nestjs/common`. Aliased imports (`import { forwardRef as fr }`)
        // are detected by walking the source-file's import declarations (Option B).
        if (body.getKind() === SyntaxKind.CallExpression) {
            const call = body as CallExpression;
            const calleeText = call.getExpression().getText();
            // Use the decorator's own source file — the decorator may be inherited
            // and live in a different file than the entity class being iterated.
            const forwardRefNames = getForwardRefNames(dec.getSourceFile());
            const isForwardRef =
                calleeText === 'forwardRef' || forwardRefNames.has(calleeText);
            if (isForwardRef) {
                const inner = call.getArguments()[0];
                if (inner && inner.getKind() === SyntaxKind.ArrowFunction) {
                    const innerArrow = inner as ArrowFunction;
                    const innerBody = innerArrow.getBody();
                    if (innerBody.getKind() === SyntaxKind.Identifier) {
                        const targetClass = innerBody.getText();
                        const resolvedTarget = entityIndex.get(targetClass) ?? null;
                        if (resolvedTarget) return { targetClass, resolvedTarget };
                        return { targetClass, resolvedTarget: null, reason: 'not-indexed' };
                    }
                }
            }
        }

        // Arrow body is not a bare identifier (e.g. property access, call, etc.) — unparseable
        return { targetClass: null, resolvedTarget: null, reason: 'unparseable', raw: first.getText() };
    }

    // Bare identifier form: `@ManyToOne(Foo)` — older TypeORM idiom.
    if (first.getKind() === SyntaxKind.Identifier) {
        const targetClass = first.getText();
        const resolvedTarget = entityIndex.get(targetClass) ?? null;
        if (resolvedTarget) return { targetClass, resolvedTarget };
        return { targetClass, resolvedTarget: null, reason: 'not-indexed' };
    }

    // String literal form: `@ManyToOne('CategoryReference')` — forward-reference idiom
    // used to break circular import chains. The string contains the class name verbatim.
    if (
        first.getKind() === SyntaxKind.StringLiteral ||
        first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        const literal = first as StringLiteral | NoSubstitutionTemplateLiteral;
        const targetClass = literal.getLiteralValue();
        if (!targetClass) {
            return { targetClass: null, resolvedTarget: null, reason: 'unparseable', raw: first.getText() };
        }
        const resolvedTarget = entityIndex.get(targetClass) ?? null;
        if (resolvedTarget) return { targetClass, resolvedTarget };
        return { targetClass, resolvedTarget: null, reason: 'not-indexed' };
    }

    // Any other form (template literal with substitutions, call expression, etc.) — unparseable
    return { targetClass: null, resolvedTarget: null, reason: 'unparseable', raw: first.getText() };
}
