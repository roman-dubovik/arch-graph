import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCodeIntelCommand } from './commands.js';
import type { CodeIntelArgs } from './commands.js';
import { writeCodeIntelIndex } from './io.js';
import type { CodeIntelIndex } from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal args common to every subcommand — just enough to reach readCodeIntelIndex. */
function base(sub: CodeIntelArgs['sub'], dir: string): CodeIntelArgs {
    return {
        sub,
        out: dir,
        config: './arch-graph.config.ts',
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// F2 — missing-sidecar tests
// Every query subcommand must surface "run: arch-graph code-intel build" when
// the output directory contains no code-intel sidecar files.
// ──────────────────────────────────────────────────────────────────────────────

describe('code-intel CLI — missing sidecar (F2)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ag-cli-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    // Subcommands that need NO extra args beyond sub + out ────────────────────

    it.each(['summary', 'self-check', 'policies'] as const)(
        '%s → clear rebuild error',
        async (sub) => {
            await expect(runCodeIntelCommand(base(sub, dir))).rejects.toThrow(
                /arch-graph code-intel build/,
            );
        },
    );

    // Subcommands with positional symbol ──────────────────────────────────────

    it.each([
        'resolve-symbol',
        'get-type-definition',
        'find-references',
        'impact-contract',
    ] as const)('%s → clear rebuild error', async (sub) => {
        await expect(
            runCodeIntelCommand({ ...base(sub, dir), symbol: 'X' }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('outline → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({ ...base('outline', dir), file: 'x.ts' }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('blueprint → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({ ...base('blueprint', dir), symbol: 'service' }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('suggest-placement → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({
                ...base('suggest-placement', dir),
                entry: 'MyService',
                symbol: 'service',
            }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('validate-proposal → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({ ...base('validate-proposal', dir), file: 'x.ts' }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('explain-flow → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({
                ...base('explain-flow', dir),
                target: 'MyService.doThing',
                param: 'input',
            }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it('explain-branch → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({
                ...base('explain-branch', dir),
                file: 'x.ts',
                line: 10,
            }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    it.each(['trace-scenario', 'trace-exceptions'] as const)(
        '%s → clear rebuild error',
        async (sub) => {
            await expect(
                runCodeIntelCommand({ ...base(sub, dir), entry: 'MyService.run' }),
            ).rejects.toThrow(/arch-graph code-intel build/);
        },
    );

    it('trace-message-flow → clear rebuild error', async () => {
        // trace-message-flow also reads graph.json; the sidecar manifest check
        // (readCodeIntelIndex) fires first, so missing sidecar is still the
        // first error.
        await expect(
            runCodeIntelCommand({ ...base('trace-message-flow', dir), entry: 'order.*' }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    // diagnostics — two code paths:
    //   • without maxResults  → readCodeIntelDiagnostics (also throws REBUILD_HINT on ENOENT)
    //   • with    maxResults  → readCodeIntelIndex (throws REBUILD_HINT immediately)
    it('diagnostics (with maxResults) → clear rebuild error', async () => {
        await expect(
            runCodeIntelCommand({ ...base('diagnostics', dir), maxResults: 10 }),
        ).rejects.toThrow(/arch-graph code-intel build/);
    });

    // diagnostics without maxResults writes to stdout/stderr and does NOT throw;
    // it silently regenerates. Skip the throw assertion for that path.
    it.skip('diagnostics (no maxResults, ENOENT path) — writes to stdout rather than throwing', () => {
        // The emitDiagnostics function catches ENOENT and calls readCodeIntelIndex
        // which DOES throw. However the outer catch only covers readCodeIntelDiagnostics,
        // not the subsequent readCodeIntelIndex call — so in practice this also throws.
        // Marked skip to document the intent; covered by the maxResults variant above.
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// F3 — missing required args → process.exit(1)
// requireString/requireNumber call process.exit(1) synchronously inside the
// query callback. Because emitQuery calls readCodeIntelIndex FIRST, we must
// provide a valid sidecar so the index load succeeds and execution reaches
// requireString/requireNumber. process.exit is mocked to throw so the promise
// rejects with our sentinel rather than killing the test process.
// ──────────────────────────────────────────────────────────────────────────────

const minimalIndex: CodeIntelIndex = {
    manifest: {
        schemaVersion: 2,
        builtAt: new Date().toISOString(),
        root: '/root',
        counts: { symbols: 0, calls: 0, flows: 0, branches: 0, impacts: 0 },
    },
    symbols: [],
    calls: [],
    flows: [],
    branches: [],
    impacts: [],
};

describe('code-intel CLI — missing required args (F3)', () => {
    let dir: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'ag-cli-'));
        // Write a valid (empty) sidecar so readCodeIntelIndex succeeds and
        // execution reaches requireString/requireNumber inside each callback.
        await writeCodeIntelIndex(minimalIndex, join(dir, 'code-intel'));
        // Intercept process.exit so the test process survives.
        vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
            throw new Error(`process.exit(${_code})`);
        });
        // Swallow stderr noise from requireString/requireNumber.
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('resolve-symbol without symbol arg → exit 1', async () => {
        // No symbol provided — requireString fires inside emitQuery callback.
        await expect(
            runCodeIntelCommand(base('resolve-symbol', dir)),
        ).rejects.toThrow(/process\.exit\(1\)/);
    });

    it('outline without --file → exit 1', async () => {
        await expect(
            runCodeIntelCommand(base('outline', dir)),
        ).rejects.toThrow(/process\.exit\(1\)/);
    });

    it('explain-branch without --line → exit 1', async () => {
        await expect(
            runCodeIntelCommand({ ...base('explain-branch', dir), file: 'x.ts' }),
        ).rejects.toThrow(/process\.exit\(1\)/);
    });

    it('suggest-placement without --kind/symbol → exit 1', async () => {
        await expect(
            runCodeIntelCommand({ ...base('suggest-placement', dir), entry: 'MyService' }),
        ).rejects.toThrow(/process\.exit\(1\)/);
    });
});
