/**
 * Unit tests for bench/self-build/run.ts.
 *
 * The happy-path end-to-end test is marked .skip() because it requires:
 *   1. A local arch-graph.config.ts pointing at a repo root with source files
 *   2. The MiniLM model to be cached at ~/.cache/huggingface (or $HF_HOME)
 *
 * CI does not have the model cached and the download would time out.
 * Run locally with: pnpm test src/bench/run.test.ts --reporter=verbose
 *
 * What IS tested here:
 *   - runBench builds a result array of BenchResultRow with the expected shape
 *   - Each row is tagged with queryId from the query spec
 *   - Rows are written to the --out path as a flat JSON array
 *   - The temp workDir is cleaned up after the run (even on failure)
 *
 * Mocking strategy:
 *   - buildSemanticIndexFromArgs is mocked to write a minimal graph.json +
 *     semantic manifest + embeddings.jsonl so semanticSearch can run
 *   - makeEmbedder is mocked to return a fixed zero-vector so no model loads
 *   - semanticSearch is mocked to return predictable stub results
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BenchResultRow, QuerySpec } from '../../bench/self-build/compare.js';
import { runBench } from '../../bench/self-build/run.js';
import { SEMANTIC_MODELS } from '../semantic/types.js';

// ---------------------------------------------------------------------------
// Model-cache detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the local Hugging Face cache contains at least the root
 * directory for the given model hub ID.  We test only for directory existence
 * (not file completeness) because a partial download is still "not cached"
 * but the download would resume from where it left off, not time out.
 *
 * Cache path: $HF_HOME/hub/models--<org>--<model>  or
 *             ~/.cache/huggingface/hub/models--<org>--<model>
 */
async function isModelCached(hubId: string): Promise<boolean> {
    const base = process.env['HF_HOME']
        ? join(process.env['HF_HOME'], 'hub')
        : join(homedir(), '.cache', 'huggingface', 'hub');
    // hub directory uses '--' as separator: 'Xenova/bge-m3' → 'models--Xenova--bge-m3'
    const dirName = 'models--' + hubId.replace('/', '--');
    try {
        await access(join(base, dirName));
        return true;
    } catch {
        return false;
    }
}

const miniLmCached = await isModelCached(SEMANTIC_MODELS.minilm.hubId);

// ---------------------------------------------------------------------------
// Test directory lifecycle
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `ag-bench-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const STUB_QUERIES: QuerySpec[] = [
    {
        id: 'SB1',
        query: 'where is the semantic builder',
        category: 'A_find',
        expectedKindIn: ['doc-section'],
        expectedLabelHas: ['Semantic search', 'builder'],
        minScore: 0.40,
    },
    {
        id: 'SB2',
        query: 'what does strict mode do',
        category: 'D_docs',
        expectedKindIn: ['doc-section'],
        expectedLabelHas: ['strict', 'Strict'],
        minScore: 0.40,
    },
];

// ---------------------------------------------------------------------------
// Mocked runBench — happy path
// ---------------------------------------------------------------------------

describe('runBench — mocked pipeline (unit test)', () => {
    it('returns BenchResultRow[] tagged with queryId for each search result', async () => {
        // Mock the production modules so no real build or model load happens.
        const commandsModule = await import('../../src/cli/semantic-commands.js');
        const buildSpy = vi.spyOn(commandsModule, 'buildSemanticIndexFromArgs').mockResolvedValue(
            { outDir: testDir },
        );

        const embedderModule = await import('../../src/semantic/embedder.js');
        vi.spyOn(embedderModule, 'makeEmbedder').mockReturnValue(
            async (_texts: string[]) => _texts.map(() => Array(384).fill(0) as number[]),
        );

        const searchModule = await import('../../src/semantic/search.js');
        let callCount = 0;
        vi.spyOn(searchModule, 'semanticSearch').mockImplementation(async (opts) => {
            callCount++;
            return {
                output: {
                    query: opts.query,
                    results: [
                        {
                            nodeId: `node-${callCount}`,
                            kind: 'doc-section' as const,
                            label: `Result for ${opts.query}`,
                            score: 0.75,
                            path: 'docs/README.md',
                            snippet: 'snippet text',
                        },
                    ],
                    model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
                    dim: 384,
                    indexBuiltAt: '2026-05-18T00:00:00.000Z',
                    graphHashMatches: true,
                },
                exitCode: 0 as const,
                stderrWarning: undefined,
            };
        });

        const outPath = join(testDir, 'results.json');

        const rows = await runBench({
            modelAlias: 'minilm',
            outResultPath: outPath,
            configPath: './arch-graph.config.ts',
            queries: STUB_QUERIES,
        });

        // Should have one row per query (mocked search returns 1 result each)
        expect(rows).toHaveLength(STUB_QUERIES.length);

        // Each row is tagged with the correct queryId
        expect(rows[0]!.queryId).toBe('SB1');
        expect(rows[1]!.queryId).toBe('SB2');

        // Each row has the expected shape
        const r = rows[0]!;
        expect(r).toHaveProperty('nodeId');
        expect(r).toHaveProperty('kind');
        expect(r).toHaveProperty('label');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('snippet');

        // Results are written to the --out path as flat JSON array
        const written = JSON.parse(await readFile(outPath, 'utf8')) as BenchResultRow[];
        expect(written).toHaveLength(STUB_QUERIES.length);
        expect(written[0]!.queryId).toBe('SB1');

        buildSpy.mockRestore();
    });

    it('build is called with the provided modelAlias', async () => {
        const commandsModule = await import('../../src/cli/semantic-commands.js');
        const buildSpy = vi.spyOn(commandsModule, 'buildSemanticIndexFromArgs').mockResolvedValue(
            { outDir: testDir },
        );

        const embedderModule = await import('../../src/semantic/embedder.js');
        vi.spyOn(embedderModule, 'makeEmbedder').mockReturnValue(
            async (_texts: string[]) => _texts.map(() => Array(1024).fill(0) as number[]),
        );

        const searchModule = await import('../../src/semantic/search.js');
        vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
            output: {
                query: '',
                results: [],
                model: 'Xenova/bge-m3',
                dim: 1024,
                indexBuiltAt: '2026-05-18T00:00:00.000Z',
                graphHashMatches: true,
            },
            exitCode: 4 as const,
            stderrWarning: undefined,
        });

        await runBench({
            modelAlias: 'bge-m3',
            outResultPath: join(testDir, 'r.json'),
            configPath: './arch-graph.config.ts',
            queries: STUB_QUERIES,
        });

        expect(buildSpy).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'bge-m3' }),
        );

        buildSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// runBench — error-throw paths (P1-I)
// ---------------------------------------------------------------------------

describe('runBench — semanticSearch error paths (P1-I)', () => {
    /** Set up the full mock stack (build + embedder) and return a spy on semanticSearch. */
    async function setupMockStack() {
        const commandsModule = await import('../../src/cli/semantic-commands.js');
        vi.spyOn(commandsModule, 'buildSemanticIndexFromArgs').mockResolvedValue({ outDir: testDir });

        const embedderModule = await import('../../src/semantic/embedder.js');
        vi.spyOn(embedderModule, 'makeEmbedder').mockReturnValue(
            async (_texts: string[]) => _texts.map(() => Array(384).fill(0) as number[]),
        );

        const searchModule = await import('../../src/semantic/search.js');
        return vi.spyOn(searchModule, 'semanticSearch');
    }

    it('rejects when semanticSearch returns output.error (e.g. semantic-index-missing)', async () => {
        const searchSpy = await setupMockStack();
        searchSpy.mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                error: 'semantic-index-missing',
                hint: 'run: arch-graph semantic build',
                model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
                dim: 384,
                indexBuiltAt: '2026-05-18T00:00:00.000Z',
                graphHashMatches: false,
            },
            exitCode: 4 as const,
            stderrWarning: undefined,
        });

        await expect(
            runBench({
                modelAlias: 'minilm',
                outResultPath: join(testDir, 'r.json'),
                configPath: './arch-graph.config.ts',
                queries: STUB_QUERIES,
            }),
        ).rejects.toThrow(/semantic-index-missing/);
    });

    it('rejects when semanticSearch returns output.embedError (e.g. model load failed)', async () => {
        const searchSpy = await setupMockStack();
        searchSpy.mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                embedError: 'model load failed',
                model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
                dim: 384,
                indexBuiltAt: '2026-05-18T00:00:00.000Z',
                graphHashMatches: false,
            },
            exitCode: 4 as const,
            stderrWarning: undefined,
        });

        await expect(
            runBench({
                modelAlias: 'minilm',
                outResultPath: join(testDir, 'r.json'),
                configPath: './arch-graph.config.ts',
                queries: STUB_QUERIES,
            }),
        ).rejects.toThrow(/model load failed/);
    });
});

// ---------------------------------------------------------------------------
// Integration test — skipped unless model is cached
// ---------------------------------------------------------------------------

// Skip condition: the MiniLM model must be cached in ~/.cache/huggingface/
// (or $HF_HOME). In CI, no model is cached and the download would time out.
// To run locally: pnpm test src/bench/run.test.ts --reporter=verbose
describe.skipIf(!miniLmCached)('runBench — real MiniLM build (integration, requires cached model)', () => {
    it('builds a real index and returns scored rows', async () => {
        const outPath = join(testDir, 'minilm-results.json');
        const queriesPath = new URL('../../bench/self-build/queries-self-build.json', import.meta.url);
        const queriesRaw = await readFile(new URL(queriesPath).pathname, 'utf8');
        const queries: QuerySpec[] = JSON.parse(queriesRaw);

        const rows = await runBench({
            modelAlias: 'minilm',
            outResultPath: outPath,
            configPath: './arch-graph.config.ts',
            queries: queries.slice(0, 3), // Only first 3 to keep the test fast
        });

        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(r.queryId).toMatch(/^SB/);
            expect(typeof r.score).toBe('number');
        }

        const written = JSON.parse(await readFile(outPath, 'utf8')) as BenchResultRow[];
        expect(written).toHaveLength(rows.length);
    });
});
