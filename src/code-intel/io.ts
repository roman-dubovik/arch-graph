import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type {
    CodeIntelBranch,
    CodeIntelCall,
    CodeIntelDiagnostics,
    CodeIntelFlow,
    CodeIntelImpact,
    CodeIntelIndex,
    CodeIntelManifest,
    CodeIntelPolicy,
    CodeIntelSymbol,
} from './types.js';
import { CODE_INTEL_SCHEMA_VERSION } from './types.js';

type CodeIntelCollectionName = 'symbols' | 'calls' | 'flows' | 'branches' | 'impacts' | 'policies';

const FILES: Record<CodeIntelCollectionName, string> = {
    symbols: 'symbols.jsonl',
    calls: 'calls.jsonl',
    flows: 'flows.jsonl',
    branches: 'branches.jsonl',
    impacts: 'impacts.jsonl',
    policies: 'policies.jsonl',
};

const REBUILD_HINT = 'run: arch-graph code-intel build';

export async function writeCodeIntelIndex(index: CodeIntelIndex, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Order: write shards first, manifest last. Combined with atomicWrite this
    // means consumers either see the full new index (manifest updated) or the
    // previous index (manifest stale) — never a half-written manifest pointing
    // at half-written shards.
    await atomicWriteJsonl(index.symbols, join(dir, FILES.symbols));
    await atomicWriteJsonl(index.calls, join(dir, FILES.calls));
    await atomicWriteJsonl(index.flows, join(dir, FILES.flows));
    await atomicWriteJsonl(index.branches, join(dir, FILES.branches));
    await atomicWriteJsonl(index.impacts, join(dir, FILES.impacts));
    await atomicWriteJsonl(index.policies ?? [], join(dir, FILES.policies));
    await atomicWrite(join(dir, 'manifest.json'), JSON.stringify(index.manifest, null, 2));
}

export async function readCodeIntelIndex(dir: string): Promise<CodeIntelIndex> {
    const manifestPath = join(dir, 'manifest.json');
    let manifestRaw: string;
    try {
        manifestRaw = await readFile(manifestPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`code-intel sidecar not found at ${dir}. ${REBUILD_HINT}`);
        }
        throw err;
    }
    let manifest: CodeIntelManifest;
    try {
        manifest = JSON.parse(manifestRaw) as CodeIntelManifest;
    } catch (parseErr) {
        throw new Error(
            `code-intel manifest at ${manifestPath} is corrupted (${(parseErr as Error).message}). ${REBUILD_HINT}`,
        );
    }
    if (manifest.schemaVersion !== CODE_INTEL_SCHEMA_VERSION) {
        throw new Error(
            `code-intel manifest schemaVersion=${manifest.schemaVersion} ` +
            `(expected ${CODE_INTEL_SCHEMA_VERSION}). ${REBUILD_HINT}`,
        );
    }
    return {
        manifest,
        symbols: await readJsonl<CodeIntelSymbol>(join(dir, FILES.symbols)),
        calls: await readJsonl<CodeIntelCall>(join(dir, FILES.calls)),
        flows: await readJsonl<CodeIntelFlow>(join(dir, FILES.flows)),
        branches: await readJsonl<CodeIntelBranch>(join(dir, FILES.branches)),
        impacts: await readJsonl<CodeIntelImpact>(join(dir, FILES.impacts)),
        policies: await readJsonl<CodeIntelPolicy>(join(dir, FILES.policies)),
    };
}

export async function writeCodeIntelDiagnostics(diagnostics: CodeIntelDiagnostics, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
}

export async function readCodeIntelDiagnostics(dir: string): Promise<CodeIntelDiagnostics> {
    const path = join(dir, 'diagnostics.json');
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`code-intel diagnostics not found at ${path}. ${REBUILD_HINT}`);
        }
        throw err;
    }
    let diagnostics: CodeIntelDiagnostics;
    try {
        diagnostics = JSON.parse(raw) as CodeIntelDiagnostics;
    } catch (parseErr) {
        throw new Error(
            `code-intel diagnostics at ${path} is corrupted (${(parseErr as Error).message}). ${REBUILD_HINT}`,
        );
    }
    if (diagnostics.schemaVersion !== CODE_INTEL_SCHEMA_VERSION) {
        throw new Error(
            `code-intel diagnostics schemaVersion=${diagnostics.schemaVersion} ` +
            `(expected ${CODE_INTEL_SCHEMA_VERSION}). ${REBUILD_HINT}`,
        );
    }
    return diagnostics;
}

/**
 * Atomic file write: write to <path>.tmp then rename. rename(2) is atomic on
 * POSIX, so a crash mid-write leaves the previous file intact rather than a
 * truncated half-file that downstream JSON.parse calls choke on.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
    const tmp = `${path}.tmp`;
    try {
        await writeFile(tmp, content, 'utf8');
        await rename(tmp, path);
    } catch (err) {
        try { await unlink(tmp); } catch { /* tmp may not exist yet */ }
        throw err;
    }
}

async function atomicWriteJsonl(records: unknown[], path: string): Promise<void> {
    await atomicWrite(path, records.map((record) => JSON.stringify(record)).join('\n'));
}

async function readJsonl<T>(path: string): Promise<T[]> {
    try {
        const stats = await stat(path);
        if (stats.size === 0) return [];
    } catch (err) {
        // Missing optional shard (e.g. legacy build without policies.jsonl)
        // tolerated; manifest schema check is the source of truth for whether
        // the index is loadable.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
    const out: T[] = [];
    const rl = createInterface({
        input: createReadStream(path, 'utf8'),
        crlfDelay: Infinity,
    });
    let lineNumber = 0;
    for await (const line of rl) {
        lineNumber++;
        if (line.trim() === '') continue;
        try {
            out.push(JSON.parse(line) as T);
        } catch (parseErr) {
            throw new Error(
                `code-intel shard ${path}: line ${lineNumber} is malformed JSON ` +
                `(${(parseErr as Error).message}). The sidecar is likely torn from an ` +
                `interrupted build. ${REBUILD_HINT}`,
            );
        }
    }
    return out;
}
