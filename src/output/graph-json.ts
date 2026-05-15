import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ArchGraph, BuildValidation, DiagnosticsReport } from '../core/types.js';

export async function writeGraphJson(graph: ArchGraph, outPath: string): Promise<void> {
    await ensureDir(outPath);
    await writeFile(outPath, JSON.stringify(graph, null, 2), 'utf8');
}

export async function writeDiagnostics(diag: DiagnosticsReport, outPath: string): Promise<void> {
    await ensureDir(outPath);
    await writeFile(outPath, JSON.stringify(diag, null, 2), 'utf8');
}

export async function writeValidationReport(
    report: BuildValidation,
    outPath: string,
): Promise<void> {
    await ensureDir(outPath);
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
}

async function ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}
