import {
    CallExpression,
    Node,
    ObjectLiteralExpression,
    Project,
    PropertyAccessExpression,
    PropertyAssignment,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { ArchGraphConfig } from '../../core/config.js';
import type { HttpApi, HttpCallSite, ResolvedUrl, SourceLoc } from '../../core/types.js';
import { buildConstantIndex, ConstantIndex } from '../nats/constant-index.js';
import { isExcludedSourceFile } from '../shared.js';
import { resolveUrl } from './url-resolver.js';

/**
 * HTTP-client extractor — finds call sites to:
 *   - `<something>.httpService.<get|post|put|patch|delete|head|options>(url, ...)`
 *     and the `firstValueFrom(this.httpService.get(url))` / `.pipe()` chain forms
 *     (we match the inner `.get(url)` call directly — no special wrapper handling needed).
 *   - `axios.<method>(url, ...)` and `axios(config)` (latter typically unresolved).
 *   - Global `fetch(url, ...)`.
 *
 * URL resolution lives in `./url-resolver.ts`; the extractor's job is purely to
 * identify the call shape, pick the right URL argument, and tag the API kind.
 *
 * Out of scope (documented in OPEN-QUESTIONS Block B):
 *   - Wrapper services (`this.platformApiClient.fetchUser(id)`) — no auto-discovery.
 *   - `axios.create({ baseURL })` cross-statement tracking — client variable bindings
 *     are not traced. Inline `axios.create({...}).get(url)` chains ARE detected (via
 *     a structural AST check: receiver must be `CallExpression` on callee `axios.create`)
 *     and emitted as unresolved so they balance the GT regex. Deferred because: across
 *     all 5 reference projects, `axios.create` is called without `baseURL` (only
 *     `timeout`/`headers`), so taint-tracking would yield zero useful URLs. A full
 *     implementation requires `Map<varName, ResolvedUrlBase>` with scope-boundary
 *     clearing (~150 LOC) for no gain on the current corpus.
 *   - GraphQL / tRPC / gRPC — separate domain entirely.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export async function extractHttp(
    _cfg: ArchGraphConfig,
    project: Project,
): Promise<HttpCallSite[]> {
    const t0 = Date.now();
    process.stdout.write(`  building URL constant index...\n`);
    const idx = buildConstantIndex(project);
    process.stdout.write(`    indexed ${idx.size()} entries in ${Date.now() - t0}ms\n`);

    const out: HttpCallSite[] = [];
    let totalFiles = 0;
    let droppedByFilter = 0;

    for (const sf of project.getSourceFiles()) {
        if (isExcludedSourceFile(sf)) continue;
        totalFiles += 1;
        if (!fileHasHttpMarker(sf)) {
            droppedByFilter += 1;
            continue;
        }
        collectFromFile(sf, idx, out);
    }

    process.stdout.write(
        `    files: ${totalFiles}, dropped by import/marker filter: ${droppedByFilter}\n`,
    );
    return out;
}

/**
 * Cheap text-level pre-filter — avoids visiting AST on files with no HTTP-ish markers.
 * Mirrors the NATS extractor's `fileHasNatsImport`; keeps a marker-set rather than an
 * import-set because `fetch` is a global and `axios` may be imported under any alias.
 *
 * `fetch(` will accept `prefetch(`/`refetch(` as well — that's a deliberate false-positive
 * in the *pre-filter* (the AST pass disambiguates by callee identifier text). The cost of
 * a wider net here is just a few extra files visited, not extra emitted sites.
 */
function fileHasHttpMarker(sf: SourceFile): boolean {
    const text = sf.getFullText();
    return (
        text.includes('httpService') ||
        text.includes('HttpService') ||
        text.includes('axios') ||
        text.includes('fetch(')
    );
}

function collectFromFile(sf: SourceFile, idx: ConstantIndex, out: HttpCallSite[]): void {
    sf.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.CallExpression) return;
        const call = node as CallExpression;
        const expr = call.getExpression();

        // -- global `fetch(url, ...)` --------------------------------------------------
        if (expr.getKind() === SyntaxKind.Identifier && expr.getText() === 'fetch') {
            pushIfArg(call, 0, 'fetch', 'fetch', idx, out);
            return;
        }

        // -- `axios(config)` -----------------------------------------------------------
        // The whole-`axios()` form is rare and usually carries `config.url` — we mark
        // unresolved unless config is an object literal with a literal `url` field.
        if (expr.getKind() === SyntaxKind.Identifier && expr.getText() === 'axios') {
            handleAxiosConfigCall(call, idx, out);
            return;
        }

        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
        const pa = expr as PropertyAccessExpression;
        const method = pa.getName();
        if (!HTTP_METHODS.has(method)) return;

        const target = pa.getExpression();
        const targetText = target.getText();

        // -- `axios.<method>(url, ...)` ------------------------------------------------
        // `axios` receiver is matched directly. Client variables from `axios.create({...})`
        // are NOT traced cross-statement (would need taint analysis), but the inline chain
        // `axios.create({...}).get(url)` is detected here and emitted as unresolved so the
        // call still appears in diagnostics (and balances the GT regex, see http-validator).
        if (targetText === 'axios') {
            pushIfArg(call, 0, method, 'axios', idx, out);
            return;
        }

        // -- `axios.create({...}).<method>(url, ...)` chain ----------------------------
        // The receiver is itself a CallExpression. Unwrap one level and check whether the
        // callee is exactly `axios.create` (property-access on the `axios` identifier).
        // We do NOT accept `foo.create().<method>()` — that's an over-match that would
        // catch any factory pattern. The GT regex (AXIOS_CREATE_RE) matches only the
        // literal `axios.create(...)` prefix, so this check must stay aligned.
        // Cross-statement tracking (`const client = axios.create(...); client.get(...)`)
        // is deliberately deferred — see the out-of-scope comment at top of file.
        if (target.getKind() === SyntaxKind.CallExpression) {
            const innerCall = target as CallExpression;
            const innerCallee = innerCall.getExpression();
            const isAxiosCreate =
                innerCallee.getKind() === SyntaxKind.PropertyAccessExpression &&
                (innerCallee as PropertyAccessExpression).getName() === 'create' &&
                (innerCallee as PropertyAccessExpression).getExpression().getKind() === SyntaxKind.Identifier &&
                (innerCallee as PropertyAccessExpression).getExpression().getText() === 'axios';
            if (isAxiosCreate) {
                out.push({
                    role: 'call',
                    url: {
                        kind: 'unresolved',
                        raw: call.getText().slice(0, 80),
                        reason: 'axios.create-chain',
                    },
                    method,
                    api: 'axios',
                    location: locOf(call),
                    enclosingClass: findEnclosingClassName(call),
                });
                return;
            }
        }

        // -- `<something>.httpService.<method>(url, ...)` ------------------------------
        // Cover both `this.httpService` and standalone `httpService` (DI-injected, etc).
        // We accept any property access whose tail is `httpService` (case-sensitive) —
        // the actual NestJS `HttpService` instance is always exposed under this name in
        // practice (it's the @nestjs/axios convention).
        if (endsWithProperty(target, 'httpService')) {
            pushIfArg(call, 0, method, 'httpService', idx, out);
            return;
        }
    });
}

/**
 * Push a call site if it has a URL argument. Resolves the URL eagerly; even
 * unresolved sites land in the output (they become diagnostics + count toward
 * recall against the regex GT).
 */
function pushIfArg(
    call: CallExpression,
    argIdx: number,
    method: string,
    api: HttpApi,
    idx: ConstantIndex,
    out: HttpCallSite[],
): void {
    const args = call.getArguments();
    const urlArg = args[argIdx];
    const resolved: ResolvedUrl = urlArg
        ? resolveUrl(urlArg, idx)
        : { kind: 'unresolved', raw: '<no-arg>', reason: 'no url argument' };
    out.push({
        role: 'call',
        url: resolved,
        method,
        api,
        location: locOf(call),
        enclosingClass: findEnclosingClassName(call),
    });
}

function handleAxiosConfigCall(call: CallExpression, idx: ConstantIndex, out: HttpCallSite[]): void {
    const args = call.getArguments();
    const cfg = args[0];
    if (!cfg) {
        out.push({
            role: 'call',
            url: { kind: 'unresolved', raw: '<axios-no-arg>', reason: 'axios called with no arg' },
            method: 'unknown',
            api: 'axios',
            location: locOf(call),
            enclosingClass: findEnclosingClassName(call),
        });
        return;
    }
    // If the arg is an inline object literal, try to read `url` + `method` directly.
    if (cfg.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = cfg as ObjectLiteralExpression;
        const urlProp = findObjectProp(obj, 'url');
        const methodProp = findObjectProp(obj, 'method');
        const methodVal = methodProp?.getInitializer();
        const method =
            methodVal &&
            (methodVal.getKind() === SyntaxKind.StringLiteral ||
                methodVal.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)
                ? (methodVal as unknown as { getLiteralText: () => string }).getLiteralText().toLowerCase()
                : 'unknown';
        const urlInit = urlProp?.getInitializer();
        const resolved: ResolvedUrl = urlInit
            ? resolveUrl(urlInit, idx)
            : { kind: 'unresolved', raw: '<axios-config-no-url>', reason: 'axios config missing url' };
        out.push({
            role: 'call',
            url: resolved,
            method,
            api: 'axios',
            location: locOf(call),
            enclosingClass: findEnclosingClassName(call),
        });
        return;
    }
    // Non-literal config: can't read url field statically.
    out.push({
        role: 'call',
        url: { kind: 'unresolved', raw: cfg.getText().slice(0, 80), reason: 'axios(config) — config not a literal object' },
        method: 'unknown',
        api: 'axios',
        location: locOf(call),
        enclosingClass: findEnclosingClassName(call),
    });
}

function endsWithProperty(node: Node, propName: string): boolean {
    if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
    return (node as PropertyAccessExpression).getName() === propName;
}

function findObjectProp(obj: ObjectLiteralExpression, name: string): PropertyAssignment | null {
    for (const p of obj.getProperties()) {
        if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const pa = p as PropertyAssignment;
        if (pa.getName() === name) return pa;
    }
    return null;
}

function locOf(node: Node): SourceLoc {
    const sf = node.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    return { file: sf.getFilePath(), line, column };
}

function findEnclosingClassName(node: Node): string | undefined {
    let cur: Node | undefined = node;
    while (cur) {
        if (Node.isClassDeclaration(cur)) return cur.getName();
        cur = cur.getParent();
    }
    return undefined;
}
