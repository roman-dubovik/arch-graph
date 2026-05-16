import type { ArchGraphConfig, HttpConfig } from '../core/config.js';
import type {
    HttpCallSite,
    HttpGroundTruthEntry,
    HttpValidationReport,
    ResolvedUrl,
} from '../core/types.js';
import { buildLineStarts, indexBy, matchByLineKey, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for HTTP. Three signals (each becomes role='call'):
 *   - `<something>.httpService.<method>(`   → NestJS `@nestjs/axios` HttpService
 *   - `axios.<method>(`                     → axios shorthand
 *   - `fetch(`                              → global fetch (heuristically guarded
 *     to avoid `arr.fetch(` and template-literal noise inside other identifiers).
 *
 * Matched against extracted sites by file:line; cardinality preserved like
 * the other validators (consume one extracted site per GT entry per role).
 *
 * `s` flag would let us span newlines but methods+open-paren are always on the
 * same line in practice — keeping the regex line-anchored avoids accidentally
 * folding two adjacent calls into one match.
 */

// `httpService.post<TResponse>(` is a common NestJS form — `<TResponse>` lives
// between the method name and the open-paren. We allow an optional `<...>` group
// (single level, no nesting) before `(`. Nested generics in `<>` are rare in
// HTTP-method calls and skipping them costs us at most a few diagnostic-only edges.
const HTTP_SERVICE_RE = /\.httpService\s*\.\s*(get|post|put|patch|delete|head|options)\s*(?:<[^<>]*>\s*)?\(/g;
const AXIOS_RE = /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*(?:<[^<>]*>\s*)?\(/g;
/**
 * `axios(<config>)` direct-call form. Matches only where `axios` is preceded by
 * line-start, whitespace, or one of `=({,;` — excludes `axios.<method>` (dot
 * follows) and bare `axios` inside identifiers.
 *
 * Zero-width lookbehind, not a consuming group: the older form `(?:^|[\s=({,;])`
 * consumed the prefix character, so on `const r =\n  axios({...})` `m.index`
 * landed on `\n` and `offsetToLineCol` reported the previous line. The extractor
 * anchors on the `a` of `axios` via `CallExpression.getStart()`, so keys
 * disagreed — false recall miss on every multi-line `axios(config)` call.
 * Lookbehind keeps `m.index` on `a` of `axios` for every prefix variant.
 */
const AXIOS_CONFIG_RE = /(?<=^|[\s=({,;])axios\s*\(/gm;
/**
 * `axios.create({...}).<method>(` chain — paired with the extractor's chain detection
 * so GT and extracted balance. The extractor emits an unresolved site at the outer
 * `.get()` location; this walker matches the same offset (anchored at `axios.create`).
 *
 * Balanced-paren walker (approach C): we scan forward from the `(` of `create(`,
 * counting `(` and `)` to find the matching close-paren at any depth.  This handles
 * arbitrary nesting (depth-0 `axios.create({})`, depth-1 `axios.create({ b: f() })`,
 * depth-2 `axios.create({ b: g(f()) })`, etc.) without the depth-limit hazard of a
 * pure regex.
 *
 * Known limitation (shared with the old regex): string literals containing unbalanced
 * parens, e.g. `axios.create({ url: 'http://x)y' }).get(…)`, can cause the walker to
 * close early.  This is the same edge-case the depth-1 regex had and is acceptable
 * given the rarity in real codebases.
 *
 * Malformed input (unmatched open paren) is handled by bailing out of the walk and
 * yielding nothing — the AST extractor still reports the site, so recall is preserved.
 */
const HTTP_METHODS_RE = /^\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/;

/** Yields `{ index, method }` for each `axios.create(…).<method>(` in `src`. */
function* matchAxiosCreateChains(
    src: string,
): Generator<{ index: number; method: string }> {
    const anchorRe = /\baxios\s*\.\s*create\s*\(/g;
    for (const anchor of src.matchAll(anchorRe)) {
        const start = anchor.index!;
        // Walk forward from the `(` of `create(` (the last char of anchor[0]).
        let pos = start + anchor[0].length - 1; // points at `(`
        let depth = 0;
        let balanced = false;
        while (pos < src.length) {
            const ch = src[pos];
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) { balanced = true; break; }
            }
            pos++;
        }
        if (!balanced) continue; // unmatched open-paren — skip

        const tail = src.slice(pos + 1); // text after the closing `)`
        const methodMatch = HTTP_METHODS_RE.exec(tail);
        if (!methodMatch) continue;
        yield { index: start, method: methodMatch[1]! };
    }
}

/**
 * Global `fetch(`. We exclude `.fetch(` (method on an object) and `<word>fetch(`
 * (identifier suffix like `prefetch`). Stripping comments first removes JSDoc noise.
 */
const FETCH_RE = /(?<![.\w])fetch\s*\(/g;

export async function enumerateHttpGroundTruth(
    cfg: ArchGraphConfig,
): Promise<HttpGroundTruthEntry[]> {
    const out: HttpGroundTruthEntry[] = [];

    for await (const { file, content } of iterateSourceFiles(cfg, 'http GT')) {
        if (
            !content.includes('httpService') &&
            !content.includes('axios') &&
            !content.includes('fetch(')
        ) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);

        const push = (m: RegExpMatchArray, context: string): void => {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(offset, lineStarts);
            out.push({
                role: 'call',
                location: { file, line, column },
                matchedText: stripped.slice(offset, offset + 80).replace(/\n.*$/s, '').trim(),
                context,
            });
        };

        for (const m of stripped.matchAll(HTTP_SERVICE_RE)) push(m, `httpService.${m[1]}`);
        for (const m of stripped.matchAll(AXIOS_RE)) push(m, `axios.${m[1]}`);
        for (const m of stripped.matchAll(AXIOS_CONFIG_RE)) push(m, 'axios');
        // `axios.create({...}).<method>(` — must run before AXIOS_CREATE is shadowed
        // by anything. AXIOS_RE only matches `axios.<method>` (not `axios.create.<method>`),
        // so there's no double-count.
        for (const hit of matchAxiosCreateChains(stripped)) {
            const { line, column } = offsetToLineCol(hit.index, lineStarts);
            out.push({
                role: 'call',
                location: { file, line, column },
                matchedText: stripped.slice(hit.index, hit.index + 80).replace(/\n.*$/s, '').trim(),
                context: `axios.create.${hit.method}`,
            });
        }
        for (const m of stripped.matchAll(FETCH_RE)) push(m, 'fetch');
    }

    return out;
}

export function buildHttpReport(
    sites: HttpCallSite[],
    groundTruth: HttpGroundTruthEntry[],
    httpCfg: HttpConfig | undefined,
): HttpValidationReport {
    const siteKeyed = indexBy(sites, (s) => `${s.location.file}:${s.location.line}`);
    const { consumed, missed } = matchByLineKey(groundTruth, siteKeyed);
    const extra = sites.filter((s) => !consumed.has(s));

    // Resolve metric (spec): only `literal` + `env-ref matched to a configured
    // internal service` count as resolved. `pattern` does NOT count — its target
    // isn't a named service even if recall captures the call.
    const internalEnvVars = collectInternalEnvVars(httpCfg);
    let internal = 0;
    let external = 0;
    let unresolvedClassification = 0;
    let resolvedForMetric = 0;
    const externalCalls: HttpCallSite[] = [];
    for (const s of sites) {
        const cls = classifyForMetric(s.url, internalEnvVars, httpCfg);
        if (cls === 'internal') {
            internal += 1;
            resolvedForMetric += 1;
        } else if (cls === 'external-literal') {
            external += 1;
            externalCalls.push(s);
            // External literals are recall-OK but not "resolved" per spec — don't bump resolvedForMetric.
        } else if (cls === 'external') {
            external += 1;
            externalCalls.push(s);
        } else {
            unresolvedClassification += 1;
        }
    }

    return {
        summary: {
            recallCalls: groundTruth.length > 0 ? (groundTruth.length - missed.length) / groundTruth.length : 1,
            resolveRate: sites.length > 0 ? resolvedForMetric / sites.length : 0,
            totalSites: sites.length,
            groundTruthCalls: groundTruth.length,
            internal,
            external,
            unresolvedClassification,
        },
        informational: {
            externalCalls,
        },
        sites,
        groundTruth,
        missed,
        extra,
    };
}

type MetricClass = 'internal' | 'external-literal' | 'external' | 'unresolved';

/**
 * Per-spec resolve classification:
 *   - literal URL whose host/pattern matches `internalServices[*].urlPatterns` → internal (resolved)
 *   - env-ref whose `envVar` matches `internalServices[*].envVars`             → internal (resolved)
 *   - literal URL not matching any internal pattern                            → external-literal (not resolved per spec)
 *   - env-ref not matching any internal envVar                                 → external (not resolved)
 *   - pattern / unresolved                                                     → unresolved (not resolved)
 *
 * "external-literal" is split from "external" so the resolve metric can stay
 * strict (spec: only internal-mapped counts) while informational counts in the
 * report still tell you how many *external* HTTP edges exist.
 */
function classifyForMetric(
    url: ResolvedUrl,
    internalEnvVars: Set<string>,
    httpCfg: HttpConfig | undefined,
): MetricClass {
    if (url.kind === 'unresolved') return 'unresolved';
    if (url.kind === 'pattern') return 'unresolved';
    if (url.kind === 'env-ref') {
        return internalEnvVars.has(url.envVar) ? 'internal' : 'external';
    }
    // literal: try urlPattern matching
    for (const svc of httpCfg?.internalServices ?? []) {
        for (const p of svc.urlPatterns ?? []) {
            if (url.value.includes(p)) return 'internal';
        }
    }
    return 'external-literal';
}

function collectInternalEnvVars(httpCfg: HttpConfig | undefined): Set<string> {
    const out = new Set<string>();
    for (const svc of httpCfg?.internalServices ?? []) {
        for (const v of svc.envVars ?? []) out.add(v);
    }
    return out;
}
