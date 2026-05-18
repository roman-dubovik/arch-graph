/**
 * Unit tests for src/cli/semantic-commands.ts — arg parsing and table-mode
 * output behaviour.
 *
 * Coverage note: semantic-commands.ts is excluded from the per-file coverage
 * gate (vitest.config.ts). Tests here verify correctness of F3/F4/F5 fixes
 * from round-2 PR review.
 *
 * Process.exit is mocked so the parser is exercisable without killing the
 * test runner.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSemanticArgs, runSemanticSearch, runSemanticBuild } from './semantic-commands.js';
import * as embedderModule from '../semantic/embedder.js';

// ---------------------------------------------------------------------------
// Test directory lifecycle (for runSemanticSearch integration tests)
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-semcli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'semantic'), { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// F4 — --k NaN guard
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --k validation (F4)', () => {
    it('calls process.exit(1) and writes to stderr for NaN --k value', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k', 'abc'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid --k value 'abc'"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for --k=abc (equals-sign form)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=abc'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid --k value 'abc'"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for --k=0 (non-positive)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=0'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("must be greater than 0"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for negative --k', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=-5'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("must be greater than 0"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('accepts a valid positive --k value', () => {
        const args = parseSemanticArgs(['search', 'my query', '--k', '5']);
        expect(args.k).toBe(5);
    });

    it('accepts valid --k= form', () => {
        const args = parseSemanticArgs(['search', 'my query', '--k=10']);
        expect(args.k).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// F5 — --kinds validation
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --kinds validation (F5)', () => {
    it('calls process.exit(1) for unknown kind', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--kinds=banana'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('banana'));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for partially unknown kinds list', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--kinds=service,banana'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('banana'));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('accepts valid kinds', () => {
        const args = parseSemanticArgs(['search', 'q', '--kinds=service,lib']);
        expect(args.kinds).toEqual(['service', 'lib']);
    });

    it('accepts --kinds space-separated form', () => {
        const args = parseSemanticArgs(['search', 'q', '--kinds', 'service,db-table']);
        expect(args.kinds).toEqual(['service', 'db-table']);
    });
});

// ---------------------------------------------------------------------------
// --exclude-kinds / --code-only / --docs-only
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — kind-bucket flags', () => {
    it('--exclude-kinds populates excludeKinds and leaves kinds undefined', () => {
        const args = parseSemanticArgs(['search', 'q', '--exclude-kinds=doc-section,lib']);
        expect(args.excludeKinds).toEqual(['doc-section', 'lib']);
        expect(args.kinds).toBeUndefined();
    });

    it('--code-only is sugar for --exclude-kinds=doc-section', () => {
        const args = parseSemanticArgs(['search', 'q', '--code-only']);
        expect(args.excludeKinds).toEqual(['doc-section']);
        expect(args.kinds).toBeUndefined();
    });

    it('--docs-only is sugar for --kinds=doc-section', () => {
        const args = parseSemanticArgs(['search', 'q', '--docs-only']);
        expect(args.kinds).toEqual(['doc-section']);
        expect(args.excludeKinds).toBeUndefined();
    });

    it('rejects --code-only combined with --docs-only', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--code-only', '--docs-only'])).toThrow(
            'process.exit',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects --code-only combined with --kinds', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() =>
            parseSemanticArgs(['search', 'q', '--code-only', '--kinds=service']),
        ).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects --exclude-kinds combined with --docs-only', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() =>
            parseSemanticArgs(['search', 'q', '--exclude-kinds=lib', '--docs-only']),
        ).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects unknown --exclude-kinds value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--exclude-kinds=banana'])).toThrow(
            'process.exit',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects --kinds combined with --exclude-kinds', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() =>
            parseSemanticArgs(['search', 'q', '--kinds=service', '--exclude-kinds=doc-section']),
        ).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects trailing --exclude-kinds with no value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--exclude-kinds'])).toThrow(
            'process.exit',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects trailing --kinds with no value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--kinds'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects --kinds specified more than once (no silent last-write-wins)', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() =>
            parseSemanticArgs(['search', 'q', '--kinds=service', '--kinds=lib']),
        ).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

// ---------------------------------------------------------------------------
// F3 — table mode: embedError branch is shown before "No results found"
// ---------------------------------------------------------------------------

describe('runSemanticSearch — embedError in table mode (F3)', () => {
    it('writes embedError to stderr in table mode instead of "No results found"', async () => {
        // Write a valid sidecar
        const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import('../semantic/types.js');
        const manifestContent = JSON.stringify({
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            builtAt: '2026-05-16T00:00:00.000Z',
            graphHash: 'a'.repeat(64),
            nodeCount: 0,
        });
        await writeFile(join(testDir, 'semantic', 'manifest.json'), manifestContent, 'utf8');
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
        // graph.json with matching hash (but we use a placeholder — hash check will fail, stale warning)
        await writeFile(join(testDir, 'graph.json'), '{}', 'utf8');

        const stderrLines: string[] = [];
        const stdoutLines: string[] = [];
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrLines.push(String(s));
            return true;
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        // Use a search module mock to return embedError without needing a real embedder
        const searchModule = await import('../semantic/search.js');
        const searchSpy = vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                indexBuiltAt: '2026-05-16T00:00:00.000Z',
                graphHashMatches: false,
                embedError: 'model unavailable',
            },
            exitCode: 1,
            stderrWarning: undefined,
        });

        try {
            await runSemanticSearch({
                sub: 'search',
                config: './arch-graph.config.ts',
                out: testDir,
                query: 'q',
                format: 'table',
                k: undefined,
                kinds: undefined,
            });
        } catch {
            // process.exit throws
        }

        const stderrOutput = stderrLines.join('');
        const stdoutOutput = stdoutLines.join('');

        expect(stderrOutput).toContain('embedding failed');
        expect(stderrOutput).toContain('model unavailable');
        // Must NOT say "No results found" in stdout
        expect(stdoutOutput).not.toContain('No results found');

        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
        exitSpy.mockRestore();
        searchSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// End-to-end wiring: parsed --code-only flag must propagate excludeKinds
// down to the semanticSearch call (regression guard).
// ---------------------------------------------------------------------------

describe('runSemanticSearch — excludeKinds wiring (parse → search)', () => {
    it('propagates --code-only excludeKinds=[doc-section] into the search call', async () => {
        const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import(
            '../semantic/types.js'
        );

        await writeFile(
            join(testDir, 'semantic', 'manifest.json'),
            JSON.stringify({
                schemaVersion: SEMANTIC_SCHEMA_VERSION,
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                builtAt: '2026-05-16T00:00:00.000Z',
                graphHash: 'a'.repeat(64),
                nodeCount: 0,
            }),
            'utf8',
        );
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
        await writeFile(join(testDir, 'graph.json'), '{}', 'utf8');

        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        const searchModule = await import('../semantic/search.js');
        const searchSpy = vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                indexBuiltAt: '2026-05-16T00:00:00.000Z',
                graphHashMatches: true,
            },
            exitCode: 4,
            stderrWarning: undefined,
        });

        const args = parseSemanticArgs(['search', 'q', '--code-only']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch {
            /* process.exit */
        }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        const callArgs = searchSpy.mock.calls[0]![0];
        expect(callArgs.excludeKinds).toEqual(['doc-section']);
        expect(callArgs.kinds).toBeUndefined();
    });

    it('propagates --docs-only kinds=[doc-section] into the search call', async () => {
        const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import(
            '../semantic/types.js'
        );

        await writeFile(
            join(testDir, 'semantic', 'manifest.json'),
            JSON.stringify({
                schemaVersion: SEMANTIC_SCHEMA_VERSION,
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                builtAt: '2026-05-16T00:00:00.000Z',
                graphHash: 'a'.repeat(64),
                nodeCount: 0,
            }),
            'utf8',
        );
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
        await writeFile(join(testDir, 'graph.json'), '{}', 'utf8');

        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        const searchModule = await import('../semantic/search.js');
        const searchSpy = vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                indexBuiltAt: '2026-05-16T00:00:00.000Z',
                graphHashMatches: true,
            },
            exitCode: 4,
            stderrWarning: undefined,
        });

        const args = parseSemanticArgs(['search', 'q', '--docs-only']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch {
            /* process.exit */
        }

        const callArgs = searchSpy.mock.calls[0]![0];
        expect(callArgs.kinds).toEqual(['doc-section']);
        expect(callArgs.excludeKinds).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// D3: runSemanticSearch — model alias precedence (D3)
// ---------------------------------------------------------------------------

/**
 * Shared helper: set up a minimal sidecar in testDir and spy on semanticSearch
 * to capture the resolved modelAlias passed through.
 */
async function setupSearchSidecarsAndSpy(dir: string) {
    const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import(
        '../semantic/types.js'
    );
    await writeFile(
        join(dir, 'semantic', 'manifest.json'),
        JSON.stringify({
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            builtAt: '2026-05-16T00:00:00.000Z',
            graphHash: 'a'.repeat(64),
            nodeCount: 0,
        }),
        'utf8',
    );
    await writeFile(join(dir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
    await writeFile(join(dir, 'graph.json'), '{}', 'utf8');

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
    }) as never);

    const searchModule = await import('../semantic/search.js');
    const searchSpy = vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
        output: {
            query: 'q',
            results: [],
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            indexBuiltAt: '2026-05-16T00:00:00.000Z',
            graphHashMatches: true,
        },
        exitCode: 4,
        stderrWarning: undefined,
    });
    return searchSpy;
}

describe('runSemanticSearch — model alias precedence (D3)', () => {
    it('CLI --model flag wins over config semantic.model', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        // Mock config to return bge-m3, but CLI passes minilm — CLI wins.
        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
            id: 'repo',
            root: '.',
            appsGlob: 'apps/*',
            semantic: { model: 'bge-m3' },
        } as never);

        const args = parseSemanticArgs(['search', 'q', '--model', 'minilm']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].modelAlias).toBe('minilm');

        configSpy.mockRestore();
    });

    it('config semantic.model wins over the hardcoded minilm default when no CLI flag', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        // Mock config to return bge-m3; no --model flag passed.
        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
            id: 'repo',
            root: '.',
            appsGlob: 'apps/*',
            semantic: { model: 'bge-m3' },
        } as never);

        const args = parseSemanticArgs(['search', 'q']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].modelAlias).toBe('bge-m3');

        configSpy.mockRestore();
    });

    it('falls back to minilm when config is absent ("config not found:" prefix)', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        // Mock config to throw the "config not found:" prefix that loadConfig uses for absent files.
        // The predicate no longer matches ENOENT directly — only the loadConfig message prefix is trusted.
        const configModule = await import('../core/config.js');
        const notFoundErr = new Error('config not found: ./arch-graph.config.ts');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(notFoundErr);

        const args = parseSemanticArgs(['search', 'q']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].modelAlias).toBe('minilm');

        configSpy.mockRestore();
    });

    it('rethrows when loadConfig throws an error that is NOT "config not found:" (P1-L)', async () => {
        // Ensure searchSpy is set up so makeEmbedder / semanticSearch calls don't fail unexpectedly
        await setupSearchSidecarsAndSpy(testDir);

        // Mock loadConfig to throw a SyntaxError — not a "config not found:" prefix
        const configModule = await import('../core/config.js');
        const syntaxErr = new Error('SyntaxError: Unexpected token in arch-graph.config.ts');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(syntaxErr);

        const args = parseSemanticArgs(['search', 'q']);
        await expect(
            runSemanticSearch({ ...args, out: testDir }),
        ).rejects.toThrow('SyntaxError: Unexpected token');

        configSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Shared build-mock helper
// ---------------------------------------------------------------------------

async function setupBuildMocks(testDir: string) {
    const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import('../semantic/types.js');

    const configModule = await import('../core/config.js');
    const configSpy = vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
        id: 'test-repo',
        root: testDir,
        appsGlob: 'apps/**',
        libsGlob: undefined,
        excludeGlobs: undefined,
    });

    const builderModule = await import('../semantic/builder.js');
    const manifest = {
        schemaVersion: SEMANTIC_SCHEMA_VERSION,
        model: SEMANTIC_MODEL,
        dim: SEMANTIC_DIM,
        builtAt: '2026-05-16T00:00:00.000Z',
        graphHash: 'a'.repeat(64),
        nodeCount: 1,
    };
    const buildSpy = vi.spyOn(builderModule, 'buildSemanticIndex').mockResolvedValue({
        manifest,
        diagnostics: {
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            counts: { indexed: 1, skipped: 0, fileReadErrors: 0, transformerErrors: 0, labelErrors: 0 },
            skippedNodes: [],
            skippedNodesTruncated: false,
            indexSizeBytes: 100,
        },
    });

    await writeFile(join(testDir, 'graph.json'), JSON.stringify({
        version: '1', buildAt: '', root: testDir, nodes: [], edges: [],
    }), 'utf8');

    return { configSpy, buildSpy };
}

// ---------------------------------------------------------------------------
// P1-3 — validateSnippetRecall is wired into runSemanticBuild
// ---------------------------------------------------------------------------

describe('runSemanticBuild — validateSnippetRecall wiring (P1-3)', () => {
    it('calls validateSnippetRecall after a successful build and prints recall lines', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        // Mock validateSnippetRecall — DU variant: kind='ok'
        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'ok',
            stats: {
                byKind: [{ kind: 'provider', total: 10, filled: 10, fillRate: 1.0, floor: 0.95, passed: true }],
                totalNodes: 10,
                totalFilled: 10,
                aggregateFillRate: 1.0,
                virtualNodes: { lib: 0, service: 0, moduleExternal: 0, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
        });

        // validateSnippetRecall must have been called
        expect(recallSpy).toHaveBeenCalledWith(join(testDir, 'semantic'));
        // stdout should contain a recall line
        const stdoutOutput = stdoutLines.join('');
        expect(stdoutOutput).toContain('recall:');
        expect(stdoutOutput).toContain('provider');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });

    it('emits Virtual nodes diagnostic line when virtualNodes counts are non-zero (CT-AC7)', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'ok',
            stats: {
                byKind: [{ kind: 'module', total: 120, filled: 120, fillRate: 1.0, floor: 0.9, passed: true }],
                totalNodes: 120,
                totalFilled: 120,
                aggregateFillRate: 1.0,
                virtualNodes: { lib: 5, service: 0, moduleExternal: 10, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
        });

        const stdoutOutput = stdoutLines.join('');
        expect(stdoutOutput).toContain('Virtual nodes');
        expect(stdoutOutput).toContain('lib: 5');
        expect(stdoutOutput).toContain('module (external): 10');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// P1-A — exit-code on corrupt + --strict-recall flag
// ---------------------------------------------------------------------------

describe('runSemanticBuild — corrupt index exits 1 unconditionally (P1-A)', () => {
    it('exits 1 and writes ERROR to stderr when indexCorrupt=true (kind=corrupt)', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'corrupt',
            malformedLines: 8,
            totalLines: 10,
        });

        const stderrLines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrLines.push(String(s));
            return true;
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        await expect(
            runSemanticBuild({
                sub: 'build',
                config: join(testDir, 'arch-graph.config.ts'),
                out: testDir,
                format: 'json',
            }),
        ).rejects.toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);
        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toContain('ERROR');
        expect(stderrOutput).toContain('corrupt');
        expect(stderrOutput).toContain('8 of 10');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});

describe('runSemanticBuild — --strict-recall flag (P1-A)', () => {
    it('exits 1 when kind=below-floor and --strict-recall is set', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'below-floor',
            failures: [{ kind: 'provider', total: 100, filled: 80, fillRate: 0.8, floor: 0.95, passed: false }],
            stats: {
                byKind: [{ kind: 'provider', total: 100, filled: 80, fillRate: 0.8, floor: 0.95, passed: false }],
                totalNodes: 100,
                totalFilled: 80,
                aggregateFillRate: 0.8,
                virtualNodes: { lib: 0, service: 0, moduleExternal: 0, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderrLines: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrLines.push(String(s));
            return true;
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        await expect(
            runSemanticBuild({
                sub: 'build',
                config: join(testDir, 'arch-graph.config.ts'),
                out: testDir,
                format: 'json',
                strictRecall: true,
            }),
        ).rejects.toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);
        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toContain('strict-recall');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });

    it('exits 0 (does NOT exit 1) when kind=below-floor without --strict-recall', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'below-floor',
            failures: [{ kind: 'provider', total: 100, filled: 80, fillRate: 0.8, floor: 0.95, passed: false }],
            stats: {
                byKind: [{ kind: 'provider', total: 100, filled: 80, fillRate: 0.8, floor: 0.95, passed: false }],
                totalNodes: 100,
                totalFilled: 80,
                aggregateFillRate: 0.8,
                virtualNodes: { lib: 0, service: 0, moduleExternal: 0, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        // Should complete without calling process.exit
        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
            strictRecall: false,
        });

        expect(exitSpy).not.toHaveBeenCalled();

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });

    it('exits 1 when kind=empty and --strict-recall is set', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'empty',
        });

        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        await expect(
            runSemanticBuild({
                sub: 'build',
                config: join(testDir, 'arch-graph.config.ts'),
                out: testDir,
                format: 'json',
                strictRecall: true,
            }),
        ).rejects.toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });

    it('emits Virtual nodes diagnostic line for below-floor result with virtual nodes (CT-AC7 below-floor path)', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'below-floor',
            failures: [{ kind: 'provider', total: 100, filled: 70, fillRate: 0.7, floor: 0.95, passed: false }],
            stats: {
                byKind: [{ kind: 'provider', total: 100, filled: 70, fillRate: 0.7, floor: 0.95, passed: false }],
                totalNodes: 100,
                totalFilled: 70,
                aggregateFillRate: 0.7,
                virtualNodes: { lib: 3, service: 0, moduleExternal: 7, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
            strictRecall: false,
        });

        const stdoutOutput = stdoutLines.join('');
        expect(stdoutOutput).toContain('Virtual nodes');
        expect(stdoutOutput).toContain('lib: 3');
        expect(stdoutOutput).toContain('module (external): 7');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });

    it('does NOT exit 1 when kind=ok and --strict-recall is set', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'ok',
            stats: {
                byKind: [{ kind: 'provider', total: 10, filled: 10, fillRate: 1.0, floor: 0.95, passed: true }],
                totalNodes: 10,
                totalFilled: 10,
                aggregateFillRate: 1.0,
                virtualNodes: { lib: 0, service: 0, moduleExternal: 0, natsSubject: 0, dbTable: 0, queue: 0, external: 0 },
            },
        });

        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        // Should complete without calling process.exit(1)
        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
            strictRecall: true,
        });

        expect(exitSpy).not.toHaveBeenCalledWith(1);

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// AC2.1/AC2.2 — --model flag parsing
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --model flag (AC2.1/AC2.2)', () => {
    it('parses --model bge-m3 on build subcommand', () => {
        const args = parseSemanticArgs(['build', '--model', 'bge-m3']);
        expect(args.model).toBe('bge-m3');
    });

    it('parses --model minilm on search subcommand', () => {
        const args = parseSemanticArgs(['search', 'my query', '--model', 'minilm']);
        expect(args.model).toBe('minilm');
    });

    it('parses --model=bge-m3 (equals-sign form)', () => {
        const args = parseSemanticArgs(['build', '--model=bge-m3']);
        expect(args.model).toBe('bge-m3');
    });

    it('defaults model to undefined when --model is omitted', () => {
        const args = parseSemanticArgs(['build']);
        expect(args.model).toBeUndefined();
    });

    it('exits 1 for unknown --model alias', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['build', '--model', 'unknown-model'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 for trailing --model with no value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['build', '--model'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

// ---------------------------------------------------------------------------
// AC2.1 — --model CLI flag overrides config model in build
// ---------------------------------------------------------------------------

describe('buildSemanticIndexFromArgs — --model flag overrides config (AC2.1)', () => {
    it('passes args.model to buildSemanticIndex when --model is set', async () => {
        const { configSpy, buildSpy } = await setupBuildMocks(testDir);
        // Config returns no semantic field (defaults to minilm)
        // but CLI passes --model bge-m3

        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'empty',
        });
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
            model: 'bge-m3',
        });

        // buildSemanticIndex should have been called with modelAlias 'bge-m3'
        expect(buildSpy).toHaveBeenCalledTimes(1);
        const callArg = buildSpy.mock.calls[0]![0];
        expect(callArg.modelAlias).toBe('bge-m3');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// E5-T2: Build wiring — embedder closure uses 'passage' mode
// ---------------------------------------------------------------------------

describe('buildSemanticIndexFromArgs — embedder closure uses passage mode (E5-T2)', () => {
    it('the embedder closure passed to buildSemanticIndex calls embed(texts, "passage")', async () => {
        const makeEmbedderSpy = vi.spyOn(embedderModule, 'makeEmbedder');

        // Track calls to embed on the returned embedder object
        const embedCalls: Array<{ texts: string[]; mode: string | undefined }> = [];
        makeEmbedderSpy.mockReturnValue({
            embed: async (texts: string[], mode?: string) => {
                embedCalls.push({ texts, mode });
                return texts.map(() => []);
            },
            embedOne: async (_text: string, _mode?: string) => [],
        } as unknown as ReturnType<typeof embedderModule.makeEmbedder>);

        const { configSpy, buildSpy } = await setupBuildMocks(testDir);
        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            kind: 'empty',
        });
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
            model: 'minilm',
        });

        // Extract the embedder closure that was passed to buildSemanticIndex
        expect(buildSpy).toHaveBeenCalledTimes(1);
        const buildCallArg = buildSpy.mock.calls[0]![0];
        const capturedEmbedder = buildCallArg.embedder as (texts: string[]) => Promise<number[][]>;

        // Invoke the captured closure and verify it routes to embed(..., 'passage')
        await capturedEmbedder(['test text']);
        expect(embedCalls).toHaveLength(1);
        expect(embedCalls[0]!.mode).toBe('passage');
        expect(embedCalls[0]!.texts).toEqual(['test text']);

        makeEmbedderSpy.mockRestore();
        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// E5-T2: Search wiring — embedOne closure uses 'query' mode
// ---------------------------------------------------------------------------

describe('runSemanticSearch — embedOne closure uses query mode (E5-T2)', () => {
    it('the embedOne closure passed to semanticSearch calls embedOne(text, "query")', async () => {
        const makeEmbedderSpy = vi.spyOn(embedderModule, 'makeEmbedder');

        const embedOneCalls: Array<{ text: string; mode: string | undefined }> = [];
        makeEmbedderSpy.mockReturnValue({
            embed: async (texts: string[], _mode?: string) => texts.map(() => []),
            embedOne: async (text: string, mode?: string) => {
                embedOneCalls.push({ text, mode });
                return [];
            },
        } as unknown as ReturnType<typeof embedderModule.makeEmbedder>);

        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const args = parseSemanticArgs(['search', 'find auth flow', '--model', 'minilm']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        // Extract the embedder closure that was passed to semanticSearch
        // (semanticSearch uses opts.embedder — a single-text (string) => number[] fn)
        expect(searchSpy).toHaveBeenCalledTimes(1);
        const searchCallArg = searchSpy.mock.calls[0]![0];
        const capturedEmbedder = searchCallArg.embedder as (text: string) => Promise<number[]>;

        // Invoke the captured closure and verify it routes to embedOne(..., 'query')
        await capturedEmbedder('find auth flow');
        expect(embedOneCalls).toHaveLength(1);
        expect(embedOneCalls[0]!.mode).toBe('query');
        expect(embedOneCalls[0]!.text).toBe('find auth flow');

        makeEmbedderSpy.mockRestore();
        searchSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Task 3: Per-model minScore calibration — CLI path
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --min-score flag (Task 3)', () => {
    it('parses --min-score 0.55 as number', () => {
        const args = parseSemanticArgs(['search', 'q', '--min-score', '0.55']);
        expect(args.minScore).toBe(0.55);
    });

    it('parses --min-score=0.40 (equals-sign form)', () => {
        const args = parseSemanticArgs(['search', 'q', '--min-score=0.40']);
        expect(args.minScore).toBe(0.40);
    });

    it('parses --min-score 0.0 (falsy float)', () => {
        const args = parseSemanticArgs(['search', 'q', '--min-score', '0.0']);
        expect(args.minScore).toBe(0.0);
    });

    it('parses --min-score -1 (lower bound)', () => {
        const args = parseSemanticArgs(['search', 'q', '--min-score', '-1']);
        expect(args.minScore).toBe(-1);
    });

    it('parses --min-score 1 (upper bound)', () => {
        const args = parseSemanticArgs(['search', 'q', '--min-score', '1']);
        expect(args.minScore).toBe(1);
    });

    it('defaults minScore to undefined when --min-score is omitted', () => {
        const args = parseSemanticArgs(['search', 'q']);
        expect(args.minScore).toBeUndefined();
    });

    it('exits 1 for non-numeric --min-score value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--min-score', 'abc'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 for --min-score value > 1', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--min-score', '1.5'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 for --min-score value < -1', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--min-score', '-2'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 for trailing --min-score with no value', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--min-score'])).toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('runSemanticSearch — minScore resolution passed to semanticSearch (Task 3)', () => {
    it('resolves minScore from modelAlias when no --min-score flag (minilm → 0.30)', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(
            new Error('config not found: ./arch-graph.config.ts'),
        );

        const args = parseSemanticArgs(['search', 'q', '--model', 'minilm']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        // minilm recommendedMinScore = 0.30
        expect(searchSpy.mock.calls[0]![0].minScore).toBe(0.30);

        configSpy.mockRestore();
    });

    it('resolves minScore from modelAlias when no --min-score flag (e5-base → 0.55)', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(
            new Error('config not found: ./arch-graph.config.ts'),
        );

        const args = parseSemanticArgs(['search', 'q', '--model', 'e5-base']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        // e5-base recommendedMinScore = 0.55
        expect(searchSpy.mock.calls[0]![0].minScore).toBe(0.55);

        configSpy.mockRestore();
    });

    it('user --min-score flag always wins over recommendedMinScore', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(
            new Error('config not found: ./arch-graph.config.ts'),
        );

        // e5-base recommended is 0.55; user passes 0.70
        const args = parseSemanticArgs(['search', 'q', '--model', 'e5-base', '--min-score', '0.70']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].minScore).toBe(0.70);

        configSpy.mockRestore();
    });

    it('user --min-score 0.0 wins (not silently dropped as falsy)', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(
            new Error('config not found: ./arch-graph.config.ts'),
        );

        const args = parseSemanticArgs(['search', 'q', '--model', 'minilm', '--min-score', '0.0']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].minScore).toBe(0.0);

        configSpy.mockRestore();
    });

    it('falls back to 0.30 when alias is the minilm default (config absent)', async () => {
        const searchSpy = await setupSearchSidecarsAndSpy(testDir);

        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockRejectedValue(
            new Error('config not found: ./arch-graph.config.ts'),
        );

        // No --model flag → resolves to 'minilm' → recommendedMinScore = 0.30
        const args = parseSemanticArgs(['search', 'q']);
        try {
            await runSemanticSearch({ ...args, out: testDir });
        } catch { /* process.exit */ }

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]![0].minScore).toBe(0.30);

        configSpy.mockRestore();
    });
});
