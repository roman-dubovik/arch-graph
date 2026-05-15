import {
    Identifier,
    Node,
    PropertyAccessExpression,
    PropertyAssignment,
    PropertyDeclaration,
    StringLiteral,
    SyntaxKind,
    TemplateExpression,
    VariableDeclaration,
} from 'ts-morph';

import type { ResolvedUrl } from '../../core/types.js';
import { ConstantIndex } from '../nats/constant-index.js';

/**
 * URL resolver — mirrors NATS subject resolver but produces a `ResolvedUrl` with
 * a dedicated `env-ref` variant for `configService.get('SERVICE_X_URL')` patterns.
 *
 * Resolution decision tree:
 *   StringLiteral / NoSubstitutionTemplateLiteral → literal
 *   TemplateExpression                            → tries env-ref-with-suffix, falls back to pattern
 *   CallExpression `configService.get('X_URL')`   → env-ref { envVar: 'X_URL' }
 *   Identifier / PropertyAccess                   → recurses via NATS ConstantIndex + declaration init
 *   Other                                         → unresolved
 *
 * Reuses the NATS `ConstantIndex` for exported `const`/`enum` lookup — the index
 * is per-project, built once in the extractor and shared between NATS + HTTP.
 *
 * NB: this resolver is intentionally narrower than the NATS one:
 *   - we don't support arbitrary `fn(...args)` returning a template (no env URLs
 *     factor like that in the corpus);
 *   - `axios.create({ baseURL })` is deferred (see OPEN-QUESTIONS Block B).
 */

const MAX_DEPTH = 6;

/**
 * Set of method names recognised on a `configService`-like object as ENV-var
 * accessors. Covers all three that appear in the corpus: `get`, `getOrThrow`,
 * and the rarer `getOrDefault`.
 */
const CONFIG_GETTER_METHODS = new Set(['get', 'getOrThrow', 'getOrDefault']);

export function resolveUrl(node: Node, idx: ConstantIndex): ResolvedUrl {
    return resolveUrlInner(node, 0, idx);
}

function resolveUrlInner(node: Node, depth: number, idx: ConstantIndex): ResolvedUrl {
    if (depth > MAX_DEPTH) {
        return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'max depth' };
    }

    switch (node.getKind()) {
        case SyntaxKind.StringLiteral:
        case SyntaxKind.NoSubstitutionTemplateLiteral: {
            return { kind: 'literal', value: (node as StringLiteral).getLiteralText() };
        }
        case SyntaxKind.TemplateExpression: {
            return resolveTemplate(node as TemplateExpression, depth, idx);
        }
        case SyntaxKind.CallExpression: {
            // The only call we explicitly support is `<configService>.get(<envVar>[, default])` —
            // recognising it here (rather than chasing the declaration) keeps the resolver simple
            // and dominant-pattern-correct.
            return resolveConfigGetCall(node, depth, idx);
        }
        case SyntaxKind.Identifier: {
            return resolveIdentifier(node as Identifier, depth, idx);
        }
        case SyntaxKind.PropertyAccessExpression: {
            return resolvePropertyAccess(node as PropertyAccessExpression, depth, idx);
        }
        case SyntaxKind.AsExpression:
        case SyntaxKind.ParenthesizedExpression:
        case SyntaxKind.TypeAssertionExpression: {
            const inner = (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
            if (inner) return resolveUrlInner(inner, depth + 1, idx);
            return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'no inner expression' };
        }
        case SyntaxKind.BinaryExpression: {
            // Unwrap `lhs ?? rhs` / `lhs || rhs` — common fallback shape:
            //   this.successUrl = this.configService.get<string>(SUCCESS_URL) ?? '';
            // Without this we'd lose env-ref resolution on every ctor URL with a default.
            // The LHS is the "happy path" value; if it doesn't resolve we try the RHS as
            // a literal fallback (which is the *not-internal* case, so usually unresolved).
            const be = node as unknown as {
                getOperatorToken: () => Node;
                getLeft: () => Node;
                getRight: () => Node;
            };
            const op = be.getOperatorToken().getKind();
            if (
                op === SyntaxKind.QuestionQuestionToken ||
                op === SyntaxKind.BarBarToken
            ) {
                const left = resolveUrlInner(be.getLeft(), depth + 1, idx);
                if (left.kind !== 'unresolved') return left;
                return resolveUrlInner(be.getRight(), depth + 1, idx);
            }
            return {
                kind: 'unresolved',
                raw: node.getText().slice(0, 80),
                reason: `unsupported binary op: ${node.getKindName()}`,
            };
        }
    }

    return {
        kind: 'unresolved',
        raw: node.getText().slice(0, 80),
        reason: `unsupported kind: ${node.getKindName()}`,
    };
}

function resolveTemplate(
    tmpl: TemplateExpression,
    depth: number,
    idx: ConstantIndex,
): ResolvedUrl {
    const head = tmpl.getHead().getLiteralText();
    const spans = tmpl.getTemplateSpans();

    // Resolve every span's expression once, up-front. The three downstream paths
    // (env-ref upgrade / literal-base upgrade / generic pattern) all consume the
    // same resolutions — doing them once keeps the function single-pass.
    const resolvedSpans = spans.map((span) => ({
        resolved: resolveUrlInner(span.getExpression(), depth + 1, idx),
        literal: span.getLiteral().getLiteralText(),
        text: span.getExpression().getText(),
    }));

    // Special case: `\`${base}/path\`` where `base` resolves to env-ref → upgrade to env-ref
    // with the suffix. This is the dominant internal-call shape; without it most internal
    // calls would degrade to `pattern` and miss the resolve metric.
    if (head === '' && resolvedSpans.length >= 1) {
        const first = resolvedSpans[0]!;
        if (first.resolved.kind === 'env-ref') {
            let suffix = first.literal;
            let hasParam = false;
            for (let i = 1; i < resolvedSpans.length; i++) {
                const r = resolvedSpans[i]!;
                if (r.resolved.kind === 'literal') suffix += r.resolved.value;
                else {
                    suffix += '*';
                    hasParam = true;
                }
                suffix += r.literal;
            }
            // Nested DU: `path` is present iff the template carried a tail beyond `${base}`.
            // A bare `\`${base}\`` (no static suffix and no further spans) yields no `path`,
            // identical to `axios.get(configService.get('X_URL'))`.
            return {
                kind: 'env-ref',
                envVar: first.resolved.envVar,
                ...(suffix !== '' ? { path: { suffix, hasParam } } : {}),
            };
        }
        if (first.resolved.kind === 'literal') {
            // First span resolves to a literal (e.g. a `const BASE = 'http://x'`).
            // Build the full URL — equivalent to a string literal at the call site.
            let url = first.resolved.value + first.literal;
            const patternPlaceholders: string[] = [];
            for (let i = 1; i < resolvedSpans.length; i++) {
                const r = resolvedSpans[i]!;
                if (r.resolved.kind === 'literal') {
                    url += r.resolved.value;
                } else {
                    url += '*';
                    patternPlaceholders.push(r.text);
                }
                url += r.literal;
            }
            if (patternPlaceholders.length === 0) return { kind: 'literal', value: url };
            return { kind: 'pattern', pattern: url, placeholders: patternPlaceholders };
        }
    }

    // Generic template — assemble pattern with `*` placeholders for non-literal spans.
    let pattern = head;
    const placeholders: string[] = [];
    for (const r of resolvedSpans) {
        if (r.resolved.kind === 'literal') pattern += r.resolved.value;
        else {
            pattern += '*';
            placeholders.push(r.text);
        }
        pattern += r.literal;
    }
    if (placeholders.length === 0) return { kind: 'literal', value: pattern };
    return { kind: 'pattern', pattern, placeholders };
}

function resolveConfigGetCall(node: Node, depth: number, idx: ConstantIndex): ResolvedUrl {
    const call = node as unknown as {
        getExpression: () => Node;
        getArguments: () => Node[];
    };
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
        return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'call not on property access' };
    }
    const pa = callee as PropertyAccessExpression;
    const method = pa.getName();
    if (!CONFIG_GETTER_METHODS.has(method)) {
        return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: `not a config getter: ${method}` };
    }

    // Receiver heuristic: text contains "config" — covers `configService`, `this.configService`,
    // `nestConfigService`, etc. without forcing the user to declare types. False-positive risk
    // is bounded: `this.fooConfigService.get('FOO_URL')` is still semantically equivalent for
    // our purpose, and a non-config `something.get(...)` rarely has a string-literal envVar arg.
    const receiverText = pa.getExpression().getText().toLowerCase();
    if (!receiverText.includes('config')) {
        return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'receiver not a configService' };
    }

    const args = call.getArguments();
    if (args.length === 0) {
        return { kind: 'unresolved', raw: node.getText().slice(0, 80), reason: 'no env-var arg' };
    }
    const first = args[0]!;
    // Direct string literal is the common form: `configService.get('PLATFORM_API_URL')`.
    if (
        first.getKind() === SyntaxKind.StringLiteral ||
        first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        return { kind: 'env-ref', envVar: (first as StringLiteral).getLiteralText() };
    }
    // Identifier / PropertyAccess: try resolving via const index — `MY_KEYS.URL` etc.
    if (
        first.getKind() === SyntaxKind.Identifier ||
        first.getKind() === SyntaxKind.PropertyAccessExpression
    ) {
        const text = first.getText();
        const entry = idx.get(text);
        if (entry && entry.kind === 'literal') {
            return { kind: 'env-ref', envVar: entry.value };
        }
    }
    return {
        kind: 'unresolved',
        raw: node.getText().slice(0, 80),
        reason: 'env-var arg not literal',
    };
}

function resolveIdentifier(node: Identifier, depth: number, idx: ConstantIndex): ResolvedUrl {
    // First try the constant index — handles imported / re-exported constants.
    const entry = idx.get(node.getText());
    if (entry && entry.kind === 'literal') return { kind: 'literal', value: entry.value };

    const sym = node.getSymbol();
    if (!sym) {
        return { kind: 'unresolved', raw: node.getText(), reason: 'no symbol' };
    }
    for (const decl of sym.getDeclarations()) {
        const k = decl.getKind();
        if (k === SyntaxKind.Parameter || k === SyntaxKind.BindingElement) {
            return { kind: 'unresolved', raw: node.getText(), reason: 'param/binding (dynamic)' };
        }
        const init = getInitializerOrValue(decl);
        if (init) {
            const r = resolveUrlInner(init, depth + 1, idx);
            if (r.kind !== 'unresolved') return r;
        }
    }
    return { kind: 'unresolved', raw: node.getText(), reason: 'identifier not resolvable' };
}

function resolvePropertyAccess(
    node: PropertyAccessExpression,
    depth: number,
    idx: ConstantIndex,
): ResolvedUrl {
    // `process.env.X` is the second canonical env-var shape (alongside `configService.get`).
    // Recognising it here lets bare `axios.get(process.env.PLATFORM_API_URL)` and template
    // forms like `\`${process.env.PLATFORM_API_URL}/users/${id}\`` upgrade to env-ref —
    // without this they'd fall through to symbol chasing (whose declaration site is in
    // Node typings) and emerge as unresolved.
    if (node.getExpression().getText() === 'process.env') {
        return { kind: 'env-ref', envVar: node.getName() };
    }

    // First check whole-dotted lookup in the constant index — handles `URLS.PLATFORM` patterns.
    const entry = idx.get(node.getText());
    if (entry && entry.kind === 'literal') return { kind: 'literal', value: entry.value };

    // Then chase the property declaration — `this.baseUrl = configService.get('X_URL')`.
    const sym = node.getNameNode().getSymbol();
    if (!sym) return { kind: 'unresolved', raw: node.getText(), reason: 'no symbol' };

    for (const decl of sym.getDeclarations()) {
        const init = getInitializerOrValue(decl);
        if (init) {
            const r = resolveUrlInner(init, depth + 1, idx);
            if (r.kind !== 'unresolved') return r;
        }
        // Also try to find an assignment in the constructor: `this.baseUrl = X`.
        if (decl.getKind() === SyntaxKind.PropertyDeclaration) {
            const assigned = findCtorAssignment(decl as PropertyDeclaration);
            if (assigned) {
                const r = resolveUrlInner(assigned, depth + 1, idx);
                if (r.kind !== 'unresolved') return r;
            }
        }
    }
    return { kind: 'unresolved', raw: node.getText(), reason: 'property not resolvable' };
}

/**
 * Find `this.<propName> = <expr>` inside the enclosing class's constructor.
 * Captures the `this.baseUrl = configService.get('X_URL')` pattern that AST
 * declaration-init chasing alone can't see (the declaration is `private baseUrl: string`).
 */
function findCtorAssignment(prop: PropertyDeclaration): Node | undefined {
    const cls = prop.getParent();
    if (!cls || !Node.isClassDeclaration(cls)) return undefined;
    const propName = prop.getName();
    for (const ctor of cls.getConstructors()) {
        const body = ctor.getBody();
        if (!body) continue;
        let found: Node | undefined;
        body.forEachDescendant((d, traversal) => {
            if (found) {
                traversal.stop();
                return;
            }
            if (d.getKind() !== SyntaxKind.BinaryExpression) return;
            const be = d as unknown as { getOperatorToken: () => Node; getLeft: () => Node; getRight: () => Node };
            const op = be.getOperatorToken();
            if (op.getKind() !== SyntaxKind.EqualsToken) return;
            const lhs = be.getLeft();
            if (lhs.getKind() !== SyntaxKind.PropertyAccessExpression) return;
            const lp = lhs as PropertyAccessExpression;
            if (lp.getExpression().getKind() !== SyntaxKind.ThisKeyword) return;
            if (lp.getName() !== propName) return;
            found = be.getRight();
            traversal.stop();
        });
        if (found) return found;
    }
    return undefined;
}

function getInitializerOrValue(decl: Node): Node | undefined {
    if (Node.isVariableDeclaration(decl)) {
        return (decl as VariableDeclaration).getInitializer();
    }
    if (Node.isPropertyAssignment(decl)) {
        return (decl as PropertyAssignment).getInitializer();
    }
    if (Node.isPropertyDeclaration(decl)) {
        return (decl as PropertyDeclaration).getInitializer();
    }
    return undefined;
}
