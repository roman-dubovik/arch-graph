import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

export async function writeCodeIntelIndex(index: CodeIntelIndex, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(index.manifest, null, 2), 'utf8');
    await writeJsonl(index.symbols, join(dir, FILES.symbols));
    await writeJsonl(index.calls, join(dir, FILES.calls));
    await writeJsonl(index.flows, join(dir, FILES.flows));
    await writeJsonl(index.branches, join(dir, FILES.branches));
    await writeJsonl(index.impacts, join(dir, FILES.impacts));
    await writeJsonl(index.policies ?? [], join(dir, FILES.policies));
}

export async function readCodeIntelIndex(dir: string): Promise<CodeIntelIndex> {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CodeIntelManifest;
    if (manifest.schemaVersion !== CODE_INTEL_SCHEMA_VERSION) {
        throw new Error(
            `code-intel manifest schemaVersion=${manifest.schemaVersion} ` +
            `(expected ${CODE_INTEL_SCHEMA_VERSION}). run: arch-graph code-intel build`,
        );
    }
    return {
        manifest,
        symbols: await readJsonl<CodeIntelSymbol>(join(dir, FILES.symbols)),
        calls: await readJsonl<CodeIntelCall>(join(dir, FILES.calls)),
        flows: await readJsonl<CodeIntelFlow>(join(dir, FILES.flows)),
        branches: await readJsonl<CodeIntelBranch>(join(dir, FILES.branches)),
        impacts: await readJsonl<CodeIntelImpact>(join(dir, FILES.impacts)),
        policies: await readJsonl<any>(join(dir, FILES.policies)),
    };
}

export async function writeCodeIntelDiagnostics(diagnostics: CodeIntelDiagnostics, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2), 'utf8');
}

export async function readCodeIntelDiagnostics(dir: string): Promise<CodeIntelDiagnostics> {
    const diagnostics = JSON.parse(await readFile(join(dir, 'diagnostics.json'), 'utf8')) as CodeIntelDiagnostics;
    if (diagnostics.schemaVersion !== CODE_INTEL_SCHEMA_VERSION) {
        throw new Error(
            `code-intel diagnostics schemaVersion=${diagnostics.schemaVersion} ` +
            `(expected ${CODE_INTEL_SCHEMA_VERSION}). run: arch-graph code-intel build`,
        );
    }
    return diagnostics;
}

async function writeJsonl(records: unknown[], path: string): Promise<void> {
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
}

async function readJsonl<T>(path: string): Promise<T[]> {
    const stats = await stat(path);
    if (stats.size === 0) return [];
    const out: T[] = [];
    const rl = createInterface({
        input: createReadStream(path, 'utf8'),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (line.trim() === '') continue;
        out.push(JSON.parse(line) as T);
    }
    return out;
}
