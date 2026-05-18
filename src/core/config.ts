import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WrapperApi } from './types.js';
import type { SemanticModelAlias } from '../semantic/types.js';
import { SEMANTIC_MODELS, defaultModelAlias } from '../semantic/types.js';

// ============================================================================
// User-facing config schema (arch-graph.config.ts)
// ============================================================================

export interface ArchGraphConfig {
    /** Stable id of this project — used as key in reports. */
    id: string;
    /** Absolute path (or relative to config file) to monorepo root. */
    root: string;
    /** Glob, relative to root, matching app directories. Example: "apps/*". */
    appsGlob: string;
    /** Glob, relative to root, matching shared library dirs. Optional. */
    libsGlob?: string;
    /** Extra path-substrings to drop from sources (e.g. "/dist-poc/"). */
    excludeGlobs?: string[];
    /** NATS extractor settings. */
    nats?: NatsConfig;
    /** HTTP extractor settings. */
    http?: HttpConfig;
    /** TS-imports extractor settings. */
    imports?: ImportsConfig;
    /** Documentation scanning settings. */
    docs?: DocsConfig;
    /** OpenAPI YAML enrichment settings. */
    openapi?: OpenApiConfig;
    /** Semantic index settings. Defaults to e5-base when omitted. */
    semantic?: SemanticConfig;
    /**
     * Opt-out flags per domain. When a domain is `true` (default) the CLI gate
     * treats zero ground-truth as a hard failure (regex-typo, missing glob, etc.).
     * Set to `false` to declare "this project legitimately has no <domain>".
     */
    domains?: {
        nats?: boolean;
        typeorm?: boolean;
        bullmq?: boolean;
        di?: boolean;
        http?: boolean;
        imports?: boolean;
        /** Track A — React/Next.js frontend extractor. Defaults to true. */
        fe?: boolean;
        /** Variant 2 — NestJS endpoint decorators (@Get, @Post, …). Defaults to true. */
        endpoint?: boolean;
        /** Variant 2 — config-field callsites (configService.get / process.env). Defaults to true. */
        config?: boolean;
        /** Variant 2 — TypeORM entity column decorators (@Column, @PrimaryColumn, …). Defaults to true. */
        dbEntityFields?: boolean;
    };
}

export interface ImportsConfig {
    /**
     * Emit file-level `ts-import` edges (one per resolved import). Off by default —
     * even a medium monorepo produces 10k+ edges, which drowns the service-level
     * graph in noise. Turn on only when explicitly inspecting file-graph topology.
     */
    fileLevel?: boolean;
}

export interface NatsConfig {
    /** Project-specific wrapper classes around NATS publish API. */
    wrapperPublishApis?: WrapperApi[];
    /** Project-specific wrapper classes around NATS subscribe API. */
    wrapperSubscribeApis?: WrapperApi[];
}

export interface HttpInternalService {
    /** Stable service id used as graph target (e.g. `my-api` → `service:my-api`). */
    id: string;
    /**
     * ENV-var names that resolve to this service's base URL — e.g. `['MY_API_URL']`.
     * An `env-ref` URL whose `envVar` matches any of these is classified internal.
     */
    envVars?: string[];
    /**
     * Substring patterns matched against the literal URL form — e.g.
     * `['http://localhost:3010', 'http://my-api']`. Cheap substring containment,
     * no glob/regex semantics (kept simple to mirror NATS's "exact match" rule).
     */
    urlPatterns?: string[];
}

export interface HttpConfig {
    /**
     * Internal services this project calls over HTTP. Each entry yields a
     * `service:<id>` target node for matching `http-call` edges. Sites whose
     * URL doesn't match any internal-service entry become `external:<hostname>`.
     */
    internalServices?: HttpInternalService[];
}

export interface DocsConfig {
    /** Glob patterns to include (relative to project root). */
    include?: string[];
    /** Glob patterns to exclude. */
    exclude?: string[];
    /** Whether to respect .gitignore when scanning. */
    respectGitignore?: boolean;
    /** Embedder-tokens per adaptive chunk (BERT-style, NOT cl100k). */
    chunkTokens?: number;
    /** Max file size in bytes before the file is skipped as oversized. */
    maxFileBytes?: number;
}

/**
 * OpenAPI YAML enrichment settings.
 *
 * Controls which YAML files are scanned for endpoint metadata (descriptions,
 * summaries, tags, parameters). Matched operations are injected into endpoint
 * node `meta.openapiInfo` and picked up by the semantic embed-text builder.
 */
export interface OpenApiConfig {
    /**
     * Glob patterns (relative to project root) matching OpenAPI YAML files.
     * Defaults to common locations: api globs and well-known openapi/swagger file names.
     * See DEFAULT_OPENAPI_GLOBS in enrich-endpoints.ts for the exact defaults.
     */
    globs?: string[];
}

/**
 * Semantic index settings in `arch-graph.config.ts`.
 * All fields are optional — omitting the entire `semantic` block is valid
 * and defaults to `{ model: 'e5-base' }`.
 */
export interface SemanticConfig {
    /**
     * Short alias for the embedding model to use.
     * Defaults to `'e5-base'` when omitted.
     */
    model?: SemanticModelAlias;
}

/** All-defaults resolution of a (possibly missing) SemanticConfig field. */
export interface ResolvedSemanticConfig {
    model: SemanticModelAlias;
}

/** Valid model aliases, checked at config-load time. */
const VALID_SEMANTIC_ALIASES = Object.keys(SEMANTIC_MODELS) as SemanticModelAlias[];

export function applySemanticDefaults(s: SemanticConfig | undefined): ResolvedSemanticConfig {
    const model: SemanticModelAlias = s?.model ?? defaultModelAlias;
    if (!VALID_SEMANTIC_ALIASES.includes(model)) {
        throw new Error(
            `config.semantic.model "${model}" is not a recognised alias. ` +
            `Valid aliases: ${VALID_SEMANTIC_ALIASES.join(', ')}`,
        );
    }
    return { model };
}

export const DOCS_DEFAULT_INCLUDE: readonly string[] = [
    'README.md',
    'docs/**/*.md',
    'apps/*/README.md',
    'libs/*/README.md',
    'packages/*/README.md',
    'CHANGELOG.md',
    'ROADMAP.md',
    // Root-level *.md files (QUICK_START.md, SETUP.md, BACKEND_SERVICES.md, etc.)
    // observed in real projects like project-c. Without this glob, project-level
    // docs that aren't standardly named get missed.
    '*.md',
];

export const DOCS_DEFAULT_EXCLUDE: readonly string[] = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    'LICENSE.md',
    '.github/**/*.md',
];

/** All-defaults resolution of a (possibly missing) DocsConfig field. */
export interface ResolvedDocsConfig {
    include: string[];
    exclude: string[];
    respectGitignore: boolean;
    chunkTokens: number;
    maxFileBytes: number;
}

export function applyDocsDefaults(d: DocsConfig | undefined): ResolvedDocsConfig {
    const chunkTokens = d?.chunkTokens ?? 100;
    const maxFileBytes = d?.maxFileBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(chunkTokens) || chunkTokens <= 0) {
        throw new Error(`docs.chunkTokens must be a positive integer, got ${String(chunkTokens)}`);
    }
    if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
        throw new Error(`docs.maxFileBytes must be a positive integer, got ${String(maxFileBytes)}`);
    }
    return {
        include: d?.include ?? [...DOCS_DEFAULT_INCLUDE],
        exclude: d?.exclude ?? [...DOCS_DEFAULT_EXCLUDE],
        respectGitignore: d?.respectGitignore ?? true,
        chunkTokens,
        maxFileBytes,
    };
}

/**
 * Identity helper for typed config authoring. Only useful when arch-graph is
 * available as a local package (e.g. `npm i -D arch-graph@file:~/.arch-graph`).
 * The generated `arch-graph.config.ts` uses a plain `export default { ... }`
 * so this helper is not required — `validateConfig` is duck-typed.
 *
 *   import { defineConfig } from 'arch-graph';
 *   export default defineConfig({ ... });
 */
export function defineConfig(cfg: ArchGraphConfig): ArchGraphConfig {
    return cfg;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Loads a config file. Supports .ts (via jiti) and .json.
 * Resolves relative paths inside the config (e.g. `root`) against the config file's
 * directory so configs are relocatable.
 */
export async function loadConfig(configPath: string): Promise<ArchGraphConfig> {
    const abs = resolve(configPath);
    if (!existsSync(abs)) {
        throw new Error(`config not found: ${abs}`);
    }

    let raw: unknown;
    if (abs.endsWith('.ts') || abs.endsWith('.mts') || abs.endsWith('.cts')) {
        raw = await loadTs(abs);
    } else if (abs.endsWith('.json')) {
        raw = JSON.parse(await readFile(abs, 'utf8'));
    } else {
        throw new Error(`unsupported config extension: ${abs}`);
    }

    const cfg = validateConfig(raw, abs);
    return normalizeConfig(cfg, dirname(abs));
}

async function loadTs(absPath: string): Promise<unknown> {
    // jiti — CJS-compatible TS loader. Imported dynamically so the CLI doesn't pay the cost
    // when loading JSON-only configs.
    const { createJiti } = await import('jiti');
    const jiti = createJiti(pathToFileURL(absPath).href, {
        interopDefault: true,
        moduleCache: false,
    });
    const mod = (await jiti.import(absPath)) as unknown;
    // ESM default export comes through as `.default`; jiti's interopDefault unwraps when possible.
    if (mod && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)) {
        return (mod as { default: unknown }).default;
    }
    return mod;
}

/** @internal — exported for unit tests; do not use in production code outside config.ts. */
export function validateConfig(raw: unknown, source: string): ArchGraphConfig {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`config in ${source} must export an object`);
    }
    const cfg = raw as Partial<ArchGraphConfig>;
    if (!cfg.id || typeof cfg.id !== 'string') {
        throw new Error(`config.id (string) required in ${source}`);
    }
    if (!cfg.root || typeof cfg.root !== 'string') {
        throw new Error(`config.root (string) required in ${source}`);
    }
    if (!cfg.appsGlob || typeof cfg.appsGlob !== 'string') {
        throw new Error(`config.appsGlob (string) required in ${source}`);
    }
    // Validate semantic.model if provided.
    if (cfg.semantic !== undefined) {
        if (typeof cfg.semantic !== 'object' || cfg.semantic === null) {
            throw new Error(`config.semantic must be an object in ${source}`);
        }
        const alias = (cfg.semantic as Partial<SemanticConfig>).model;
        if (alias !== undefined && !(VALID_SEMANTIC_ALIASES as string[]).includes(alias)) {
            throw new Error(
                `config.semantic.model "${alias}" is not a recognised alias in ${source}. ` +
                `Valid aliases: ${VALID_SEMANTIC_ALIASES.join(', ')}`,
            );
        }
    }

    return cfg as ArchGraphConfig;
}

function normalizeConfig(cfg: ArchGraphConfig, configDir: string): ArchGraphConfig {
    const root = isAbsolute(cfg.root) ? cfg.root : resolve(configDir, cfg.root);

    // `http.internalServices` entry must carry at least one match criterion.
    // An entry with neither `envVars` nor `urlPatterns` is structurally inert —
    // no env-ref will match it, no literal URL will match it, so the entry exists
    // only as configuration debt. Reject at load time rather than letting it silently
    // contribute to nothing.
    for (const svc of cfg.http?.internalServices ?? []) {
        const hasEnv = (svc.envVars ?? []).length > 0;
        const hasUrl = (svc.urlPatterns ?? []).length > 0;
        if (!hasEnv && !hasUrl) {
            throw new Error(
                `config.http.internalServices[${svc.id}] has neither envVars nor urlPatterns — ` +
                    `entry is inert; remove or add a match criterion`,
            );
        }
    }

    return { ...cfg, root };
}
