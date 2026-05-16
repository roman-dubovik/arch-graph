/**
 * Unit tests for embedder.ts.
 *
 * The @xenova/transformers pipeline is mocked — no network calls, no model
 * downloads. The mock is injected via the module-internal test helpers
 * _setPipelineForTesting / _resetPipelineForTesting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock @xenova/transformers before importing the module under test.
// Vitest hoists vi.mock() calls to the top of the file automatically.
vi.mock('@xenova/transformers', () => ({
    pipeline: vi.fn(),
}));

// Import after mock is set up.
import { pipeline } from '@xenova/transformers';
import { _resetPipelineForTesting, embed, embedOne } from './embedder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake pipeline that returns predictable vectors. */
function fakePipeline(dim = 384) {
    return vi.fn().mockImplementation(async (texts: string | string[]) => {
        const inputs = Array.isArray(texts) ? texts : [texts];
        const rows = inputs.map((_, i) => Array.from({ length: dim }, (__, j) => (i + j) / dim));
        return {
            tolist: () => rows,
        };
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('embed', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        vi.mocked(pipeline).mockResolvedValue(fakePipeline() as unknown as Awaited<ReturnType<typeof pipeline>>);
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('returns empty array for empty input', async () => {
        const result = await embed([]);
        expect(result).toEqual([]);
        // Pipeline should not be initialised for empty input.
        expect(pipeline).not.toHaveBeenCalled();
    });

    it('returns one vector per input text', async () => {
        const result = await embed(['hello world', 'arch-graph rules']);
        expect(result).toHaveLength(2);
        expect(result[0]).toHaveLength(384);
        expect(result[1]).toHaveLength(384);
    });

    it('reuses the singleton — pipeline() initialiser is called only once', async () => {
        await embed(['first call']);
        await embed(['second call']);
        // pipeline() factory is called once to build the singleton.
        expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it('uses the correct model name', async () => {
        await embed(['test']);
        expect(pipeline).toHaveBeenCalledWith(
            'feature-extraction',
            'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        );
    });

    it('vectors are numbers, not NaN', async () => {
        const [vec] = await embed(['semantic search']);
        expect(vec.every((v) => typeof v === 'number' && !isNaN(v))).toBe(true);
    });

    it('PT-P1-5: calls extractor with { pooling: "mean", normalize: true }', async () => {
        // Capture the extractor mock returned by pipeline() so we can assert
        // the options passed to it.  Without normalize: true, cosine math is
        // meaningless on unnormalised vectors.
        const fakeExtractor = fakePipeline();
        vi.mocked(pipeline).mockResolvedValue(fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>);

        await embed(['cosine-correctness check']);

        expect(fakeExtractor).toHaveBeenCalledWith(
            expect.anything(),
            { pooling: 'mean', normalize: true },
        );
    });
});

describe('embedOne', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        vi.mocked(pipeline).mockResolvedValue(fakePipeline() as unknown as Awaited<ReturnType<typeof pipeline>>);
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('returns a single vector of length 384', async () => {
        const vec = await embedOne('single text');
        expect(vec).toHaveLength(384);
    });

    it('vector values are finite numbers', async () => {
        const vec = await embedOne('arch graph node');
        expect(vec.every((v) => isFinite(v))).toBe(true);
    });
});
