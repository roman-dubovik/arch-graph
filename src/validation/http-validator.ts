import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ArchGraphConfig, HttpConfig } from '../core/config.js';
import type {
    HttpCallSite,
    HttpGroundTruthEntry,
    HttpValidationReport,
    ResolvedUrl,
} from '../core/types.js';
import { buildLineStarts, indexBy, offsetToLineCol } from './line-index.js';
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
 * `axios(<config>)` direct-call form. Restricted to `await axios(` / `= axios(` /
 * `return axios(` / standalone `axios(` so it doesn't match the `axios.<method>` cases.
 */
const AXIOS_CONFIG_RE = /(?:^|[\s=({,;])axios\s*\(/g;
/**
 * Global `fetch(`. We exclude `.fetch(` (method on an object) and `<word>fetch(`
 * (identifier suffix like `prefetch`). Stripping comments first removes JSDoc noise.
 */
const FETCH_RE = /(?<![.\w])fetch\s*\(/g;

export async function enumerateHttpGroundTruth(
    cfg: ArchGraphConfig,
): Promise<HttpGroundTruthEntry[]> {
    const root = resolve(cfg.root);
    const files = await fg(
        [`${cfg.appsGlob}/**/*.ts`, ...(cfg.libsGlob ? [`${cfg.libsGlob}/**/*.ts`] : [])],
        {
            cwd: root,
            absolute: true,
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/.claude/**',
                '**/.worktrees/**',
                '**/*.spec.ts',
                '**/*.test.ts',
                '**/*.d.ts',
                ...(cfg.excludeGlobs?.map((g) => `**${g}**`) ?? []),
            ],
        },
    );

    const out: HttpGroundTruthEntry[] = [];

    for (const file of files) {
        let content: string;
        try {
            content = await readFile(file, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') continue;
            throw new Error(`http GT read failed for ${file}: ${e.code ?? e.message}`, { cause: err });
        }
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

    const missed: HttpGroundTruthEntry[] = [];
    const consumed = new Set<HttpCallSite>();
    for (const g of groundTruth) {
        const k = `${g.location.file}:${g.location.line}`;
        const match = (siteKeyed.get(k) ?? []).find((c) => !consumed.has(c));
        if (match) consumed.add(match);
        else missed.push(g);
    }
    const extra = sites.filter((s) => !consumed.has(s));

    // Resolve metric (spec): only `literal` + `env-ref matched to a configured
    // internal service` count as resolved. `pattern` does NOT count — its target
    // isn't a named service even if recall captures the call.
    const internalEnvVars = collectInternalEnvVars(httpCfg);
    let internal = 0;
    let external = 0;
    let unresolvedClassification = 0;
    let resolvedForMetric = 0;
    for (const s of sites) {
        const cls = classifyForMetric(s.url, internalEnvVars, httpCfg);
        if (cls === 'internal') {
            internal += 1;
            resolvedForMetric += 1;
        } else if (cls === 'external-literal') {
            external += 1;
            // External literals are recall-OK but not "resolved" per spec — don't bump resolvedForMetric.
        } else if (cls === 'external') {
            external += 1;
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
