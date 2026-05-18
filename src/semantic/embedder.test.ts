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
import { _resetPipelineForTesting, embed, embedOne, makeEmbedder } from './embedder.js';
import { SEMANTIC_MODELS } from './types.js';

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


describe('makeEmbedder — e5-base (prefix required)', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        vi.mocked(pipeline).mockResolvedValue(
            fakePipeline(SEMANTIC_MODELS['e5-base'].dim) as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('loads e5-base hub model', async () => {
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['hello']);
        expect(pipeline).toHaveBeenCalledWith('feature-extraction', SEMANTIC_MODELS['e5-base'].hubId);
    });

    it('calls extractor with { pooling: "mean", normalize: true }', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['mean-pooling test']);
        expect(fakeExtractor).toHaveBeenCalledWith(
            expect.anything(),
            { pooling: 'mean', normalize: true },
        );
    });

    it('returns 768-dim vectors for e5-base', async () => {
        const embedder = makeEmbedder('e5-base');
        const result = await embedder.embed(['dimension check']);
        expect(result[0]).toHaveLength(SEMANTIC_MODELS['e5-base'].dim);
    });

    it('prepends "passage: " prefix in passage mode', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['hello'], 'passage');
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['passage: hello'],
            expect.anything(),
        );
    });

    it('prepends "query: " prefix in query mode', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['hello'], 'query');
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['query: hello'],
            expect.anything(),
        );
    });

    it('defaults to passage mode when mode is omitted', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['hello']);
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['passage: hello'],
            expect.anything(),
        );
    });

    it('embedOne uses passage mode by default', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embedOne('hello');
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['passage: hello'],
            expect.anything(),
        );
    });

    it('embedOne uses query mode when requested', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embedOne('hello', 'query');
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['query: hello'],
            expect.anything(),
        );
    });

    it('applies prefix to each text in a batch', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['e5-base'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('e5-base');
        await embedder.embed(['foo', 'bar', 'baz'], 'query');
        expect(fakeExtractor).toHaveBeenCalledWith(
            ['query: foo', 'query: bar', 'query: baz'],
            expect.anything(),
        );
    });

    it('caches e5-base pipeline separately from minilm', async () => {
        vi.mocked(pipeline)
            .mockResolvedValueOnce(fakePipeline(384) as unknown as Awaited<ReturnType<typeof pipeline>>)   // minilm
            .mockResolvedValueOnce(fakePipeline(768) as unknown as Awaited<ReturnType<typeof pipeline>>);  // e5-base

        await embed(['minilm text']);
        await makeEmbedder('e5-base').embed(['e5 text']);

        // Each alias needs one pipeline init = 2 total
        expect(pipeline).toHaveBeenCalledTimes(2);

        // Second calls should all hit cache
        await embed(['minilm second']);
        await makeEmbedder('e5-base').embed(['e5 second']);
        expect(pipeline).toHaveBeenCalledTimes(2);
    });
});

describe('makeEmbedder — minilm mode no-op', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        vi.mocked(pipeline).mockResolvedValue(
            fakePipeline(384) as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('mode is a no-op for minilm (no prefix configured)', async () => {
        const fakeExtractor = fakePipeline(384);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('minilm');
        await embedder.embed(['hello'], 'passage');
        await embedder.embed(['hello'], 'query');
        // Also verify default mode (no mode arg) passes text unchanged
        await embedder.embed(['hello']);
        const calls = fakeExtractor.mock.calls;
        expect(calls[0][0]).toEqual(['hello']);
        expect(calls[1][0]).toEqual(['hello']);
        expect(calls[2][0]).toEqual(['hello']);
    });
});

// ---------------------------------------------------------------------------
// getPipeline in-flight guard — concurrent calls must not double-download (P1)
// ---------------------------------------------------------------------------

describe('getPipeline — in-flight promise deduplication (P1)', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('two concurrent embedOne calls share a single pipeline() factory invocation', async () => {
        // Use a slow pipeline factory (resolves after a microtask) so both calls
        // are in-flight simultaneously before the first one resolves.
        let factoryCalls = 0;
        vi.mocked(pipeline).mockImplementation(async () => {
            factoryCalls++;
            // Yield to the event loop so the second concurrent call can arrive.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            return fakePipeline(384) as unknown as Awaited<ReturnType<typeof pipeline>>;
        });

        const embedder = makeEmbedder('minilm');
        // Fire two concurrent calls — neither has resolved yet when the second starts.
        await Promise.all([
            embedder.embedOne('hello'),
            embedder.embedOne('world'),
        ]);

        // The underlying pipeline() factory must have been called exactly once.
        expect(factoryCalls).toBe(1);
    });
});
