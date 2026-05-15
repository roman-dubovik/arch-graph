import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WrapperApi } from './types.js';

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
    /**
     * Opt-out flags per domain. When a domain is `true` (default) the CLI gate
     * treats zero ground-truth as a hard failure (regex-typo, missing glob, etc.).
     * Set to `false` to declare "this project legitimately has no <domain>".
     */
    domains?: {
        nats?: boolean;
        typeorm?: boolean;
    };
}

export interface NatsConfig {
    /** Project-specific wrapper classes around NATS publish API. */
    wrapperPublishApis?: WrapperApi[];
    /** Project-specific wrapper classes around NATS subscribe API. */
    wrapperSubscribeApis?: WrapperApi[];
}

/**
 * Helper for typed config authoring:
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

function validateConfig(raw: unknown, source: string): ArchGraphConfig {
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
    return cfg as ArchGraphConfig;
}

function normalizeConfig(cfg: ArchGraphConfig, configDir: string): ArchGraphConfig {
    const root = isAbsolute(cfg.root) ? cfg.root : resolve(configDir, cfg.root);
    return { ...cfg, root };
}
