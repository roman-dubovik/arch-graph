import {
    ArrayLiteralExpression,
    CallExpression,
    Identifier,
    Node,
    ObjectLiteralExpression,
    Project,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type {
    DiModuleRef,
    DiModuleSite,
    DiProviderRef,
    SourceLoc,
} from '../../core/types.js';
import { isExcludedSourceFile } from '../shared.js';
import { buildDiModuleIndex, DiModuleIndex } from './module-index.js';

/**
 * NestJS DI extractor — walks classes with `@Module(...)` and decodes each
 * field of the metadata object into structured refs:
 *
 *   - imports     → DiModuleRef (class | dynamic | unresolved)
 *   - providers   → DiProviderRef (class | token{providerKind} | unresolved)
 *   - exports     → DiProviderRef
 *   - controllers → DiProviderRef (always `class`-shaped in practice)
 *
 * Decoding rules:
 *   - Bare identifier             → class ref by that name
 *   - CallExpression (Foo.bar())  → leftmost identifier of callee = module class name
 *                                   (NestJS "dynamic module" factory — args are not architectural)
 *   - Object literal in providers/exports → see `decodeProviderObject`
 *   - SpreadElement / anything else       → unresolved (flagged on the site)
 *
 * Spread elements (`...sharedImports`) are intentionally not recursed into:
 *   - their target lives in another file and may itself contain dynamic refs;
 *   - the safer signal is to emit a diagnostic and mark `hasDynamic<Field>` true.
 */

export interface ExtractDiResult {
    modules: DiModuleSite[];
    moduleIndex: DiModuleIndex;
}

export async function extractDi(_cfg: ArchGraphConfig, project: Project): Promise<ExtractDiResult> {
    const moduleIndex = buildDiModuleIndex(project);
    const modules: DiModuleSite[] = [];

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        if (!sf.getFullText().includes('@Module')) continue;

        for (const cls of sf.getClasses()) {
            const dec = cls.getDecorator('Module');
            if (!dec) continue;

            const className = cls.getName();
            // Anonymous default-export `@Module(...)` classes have no name; skip — they're
            // architecturally invisible (no other module can reference them by name).
            if (!className) continue;

            const args = dec.getArguments();
            const arg0 = args[0];
            const decLoc = locationOf(sf, dec.getStart());

            const site: DiModuleSite = {
                className,
                location: decLoc,
                imports: [],
                providers: [],
                exports: [],
                controllers: [],
                fieldLocations: { imports: null, providers: null, exports: null, controllers: null },
                flags: {
                    hasDynamicImports: false,
                    hasDynamicProviders: false,
                    hasDynamicExports: false,
                    hasDynamicControllers: false,
                },
            };

            if (arg0 && arg0.getKind() === SyntaxKind.ObjectLiteralExpression) {
                fillSiteFromMetadata(site, arg0 as ObjectLiteralExpression);
            }
            // `@Module()` with no arg or with non-object arg — keep the site (so it counts toward
            // module-recall GT), but with empty fields. Rare and legal-but-useless code.

            modules.push(site);
        }
    }

    return { modules, moduleIndex };
}

function fillSiteFromMetadata(site: DiModuleSite, obj: ObjectLiteralExpression): void {
    decodeField(site, obj, 'imports', decodeModuleRef);
    decodeField(site, obj, 'providers', decodeProviderRef);
    decodeField(site, obj, 'exports', decodeProviderRef);
    decodeField(site, obj, 'controllers', decodeProviderRef);
}

/** Generic field decoder — branchless over field-name; behavior diverges only in `decoder`. */
function decodeField<R extends DiModuleRef | DiProviderRef>(
    site: DiModuleSite,
    obj: ObjectLiteralExpression,
    field: 'imports' | 'providers' | 'exports' | 'controllers',
    decoder: (n: Node) => R,
): void {
    const prop = findProp(obj, field);
    if (!prop) return;

    // `fieldLocations[field]` doubles as the "field is present" signal — no separate flag needed.
    site.fieldLocations[field] = locationOfNameToken(prop);

    const init = prop.getInitializer();
    const arr = arrayInitializer(init);
    if (!arr) {
        if (init) {
            // `imports: someConst` / `imports: someFn().concat(...)` — non-array initializer.
            // Architecturally opaque without inlining; mark dynamic and record one diagnostic entry.
            setFlagDynamic(site, field);
            const ref: DiModuleRef | DiProviderRef = {
                kind: 'unresolved',
                raw: snippet(init),
                reason: 'non-array-initializer',
            };
            pushRef(site, field, ref);
        }
        return;
    }

    for (const el of arr.getElements()) {
        const ref = decoder(el);
        // Any unresolved entry indicates a dynamic / opaque element we can't enumerate.
        // The flag is used by downstream tooling to decide "trust this module's import list" —
        // a single spread or ternary is enough to break that contract, so all unresolved kinds
        // flip the flag, not only spreads.
        if (ref.kind === 'unresolved') {
            setFlagDynamic(site, field);
        }
        pushRef(site, field, ref);
    }
}

function setFlagDynamic(site: DiModuleSite, field: 'imports' | 'providers' | 'exports' | 'controllers'): void {
    if (field === 'imports') site.flags.hasDynamicImports = true;
    else if (field === 'providers') site.flags.hasDynamicProviders = true;
    else if (field === 'exports') site.flags.hasDynamicExports = true;
    else site.flags.hasDynamicControllers = true;
}

function pushRef(
    site: DiModuleSite,
    field: 'imports' | 'providers' | 'exports' | 'controllers',
    ref: DiModuleRef | DiProviderRef,
): void {
    if (field === 'imports') site.imports.push(ref as DiModuleRef);
    else if (field === 'providers') site.providers.push(ref as DiProviderRef);
    else if (field === 'exports') site.exports.push(ref as DiProviderRef);
    else site.controllers.push(ref as DiProviderRef);
}

/** Decode one element of `imports: [...]`. */
function decodeModuleRef(node: Node): DiModuleRef {
    const kind = node.getKind();

    if (kind === SyntaxKind.Identifier) {
        return { kind: 'class', name: (node as Identifier).getText() };
    }
    if (kind === SyntaxKind.CallExpression) {
        // `TypeOrmModule.forFeature(...)` / `ConfigModule.forRoot({...})` /
        // `BullModule.registerQueue(...)` — dynamic-module factory pattern. The leftmost
        // identifier of the callee names the producing module class; arguments configure
        // it but don't change the architectural target.
        const callee = (node as CallExpression).getExpression();
        const root = leftmostIdentifier(callee);
        if (root) {
            return { kind: 'dynamic', name: root, via: snippet(callee) };
        }
        return { kind: 'unresolved', raw: snippet(node), reason: 'call-expression-no-identifier' };
    }
    if (kind === SyntaxKind.SpreadElement) {
        return { kind: 'unresolved', raw: snippet(node), reason: 'spread' };
    }
    if (kind === SyntaxKind.PropertyAccessExpression) {
        // `imports: [SomeNamespace.SubModule]` — unusual; the leftmost identifier names the module.
        const root = leftmostIdentifier(node);
        if (root) return { kind: 'class', name: root };
        return { kind: 'unresolved', raw: snippet(node), reason: 'property-access' };
    }
    if (kind === SyntaxKind.AsExpression) {
        // `Foo.forRoot(...) as DynamicModule` — unwrap the cast.
        const inner = (node as unknown as { getExpression: () => Node }).getExpression();
        return decodeModuleRef(inner);
    }
    if (kind === SyntaxKind.ConditionalExpression) {
        // `cond ? A : B` — could pick either branch; honest-unresolved is safer than guessing.
        return { kind: 'unresolved', raw: snippet(node), reason: 'conditional' };
    }
    if (kind === SyntaxKind.ObjectLiteralExpression) {
        // Encountered in the wild: `imports: [{ ...StorageInfraModule.forRoot(), global: true }]`.
        // The architectural target is whichever module was spread in; scan for the first SpreadAssignment
        // and recurse into its expression.
        for (const prop of (node as ObjectLiteralExpression).getProperties()) {
            if (prop.getKind() === SyntaxKind.SpreadAssignment) {
                const inner = (prop as unknown as { getExpression: () => Node }).getExpression();
                const ref = decodeModuleRef(inner);
                if (ref.kind !== 'unresolved') return ref;
            }
        }
        return { kind: 'unresolved', raw: snippet(node), reason: 'object-literal-no-spread' };
    }
    return { kind: 'unresolved', raw: snippet(node), reason: `unhandled-${SyntaxKind[kind]}` };
}

/** Decode one element of `providers: [...]` / `exports: [...]` / `controllers: [...]`. */
function decodeProviderRef(node: Node): DiProviderRef {
    const kind = node.getKind();

    if (kind === SyntaxKind.Identifier) {
        return { kind: 'class', name: (node as Identifier).getText() };
    }
    if (kind === SyntaxKind.PropertyAccessExpression) {
        // `exports: [Namespace.TOKEN]` — rare. Use the full dotted name as label.
        // Plain `getText()` (not `snippet`) since dotted names have no whitespace and we
        // shouldn't truncate them at 80 chars — a deep namespace like `Foo.Bar.BAZ_TOKEN`
        // is still a single architectural identifier.
        return { kind: 'class', name: node.getText().trim() };
    }
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        // `exports: ['MY_TOKEN']` — string provider token. Strip quotes.
        const text = node.getText().replace(/^['"`]|['"`]$/g, '');
        return { kind: 'token', name: text, providerKind: 'unknown' };
    }
    if (kind === SyntaxKind.ObjectLiteralExpression) {
        return decodeProviderObject(node as ObjectLiteralExpression);
    }
    if (kind === SyntaxKind.SpreadElement) {
        return { kind: 'unresolved', raw: snippet(node), reason: 'spread' };
    }
    if (kind === SyntaxKind.AsExpression) {
        const inner = (node as unknown as { getExpression: () => Node }).getExpression();
        return decodeProviderRef(inner);
    }
    return { kind: 'unresolved', raw: snippet(node), reason: `unhandled-${SyntaxKind[kind]}` };
}

/**
 * Decode `{ provide: X, useClass: Foo }` and friends.
 *
 *   useClass    → name = useClass identifier, providerKind = 'class'
 *   useExisting → name = useExisting identifier, providerKind = 'existing'
 *   useValue    → name = provide-token text, providerKind = 'value'
 *   useFactory  → name = provide-token text, providerKind = 'factory'
 *   (none)      → providerKind = 'unknown'
 *
 * `provideToken` is preserved when it differs from `name` so downstream tooling
 * can show "TOKEN → Foo" relationships.
 */
function decodeProviderObject(obj: ObjectLiteralExpression): DiProviderRef {
    const provideProp = findProp(obj, 'provide');
    const provideToken = provideProp ? identifierLikeText(provideProp.getInitializer()) : undefined;

    const useClass = findProp(obj, 'useClass');
    if (useClass) {
        const name = identifierLikeText(useClass.getInitializer()) ?? snippet(useClass);
        return {
            kind: 'token',
            name,
            providerKind: 'class',
            ...(provideToken && provideToken !== name ? { provideToken } : {}),
        };
    }
    const useExisting = findProp(obj, 'useExisting');
    if (useExisting) {
        const name = identifierLikeText(useExisting.getInitializer()) ?? snippet(useExisting);
        return {
            kind: 'token',
            name,
            providerKind: 'existing',
            ...(provideToken && provideToken !== name ? { provideToken } : {}),
        };
    }
    const useFactory = findProp(obj, 'useFactory');
    if (useFactory) {
        return { kind: 'token', name: provideToken ?? '<no-provide>', providerKind: 'factory' };
    }
    const useValue = findProp(obj, 'useValue');
    if (useValue) {
        return { kind: 'token', name: provideToken ?? '<no-provide>', providerKind: 'value' };
    }
    if (provideToken) {
        return { kind: 'token', name: provideToken, providerKind: 'unknown' };
    }
    return { kind: 'unresolved', raw: snippet(obj), reason: 'object-no-provide-no-useX' };
}

// ============================================================================
// AST helpers
// ============================================================================

function arrayInitializer(init: Node | undefined): ArrayLiteralExpression | null {
    if (!init) return null;
    if (init.getKind() === SyntaxKind.ArrayLiteralExpression) return init as ArrayLiteralExpression;
    if (init.getKind() === SyntaxKind.AsExpression) {
        const inner = (init as unknown as { getExpression: () => Node }).getExpression();
        if (inner.getKind() === SyntaxKind.ArrayLiteralExpression) return inner as ArrayLiteralExpression;
    }
    return null;
}

function findProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = prop as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}

/** Leftmost identifier of `Foo`, `Foo.bar`, `Foo.bar()`, `(Foo.bar)()` etc. */
function leftmostIdentifier(node: Node): string | null {
    let n: Node = node;
    while (true) {
        const k = n.getKind();
        if (k === SyntaxKind.Identifier) return (n as Identifier).getText();
        if (k === SyntaxKind.PropertyAccessExpression) {
            n = (n as unknown as { getExpression: () => Node }).getExpression();
            continue;
        }
        if (k === SyntaxKind.CallExpression) {
            n = (n as CallExpression).getExpression();
            continue;
        }
        if (k === SyntaxKind.ParenthesizedExpression) {
            n = (n as unknown as { getExpression: () => Node }).getExpression();
            continue;
        }
        return null;
    }
}

/** Text of a node that's reasonably a single name (Identifier, PropertyAccess, quoted string). */
function identifierLikeText(init: Node | undefined): string | undefined {
    if (!init) return undefined;
    const k = init.getKind();
    if (k === SyntaxKind.Identifier) return (init as Identifier).getText();
    if (k === SyntaxKind.PropertyAccessExpression) return snippet(init);
    if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        return init.getText().replace(/^['"`]|['"`]$/g, '');
    }
    return undefined;
}

function snippet(n: Node): string {
    return n.getText().replace(/\s+/g, ' ').slice(0, 80);
}

function locationOf(sf: SourceFile, pos: number): SourceLoc {
    const lc = sf.getLineAndColumnAtPos(pos);
    return { file: sf.getFilePath(), line: lc.line, column: lc.column };
}

function locationOfNameToken(prop: PropertyAssignment): SourceLoc {
    const nameNode = prop.getNameNode();
    const sf = prop.getSourceFile();
    const lc = sf.getLineAndColumnAtPos(nameNode.getStart());
    return { file: sf.getFilePath(), line: lc.line, column: lc.column };
}
