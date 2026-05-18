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

describe('makeEmbedder — bge-m3', () => {
    beforeEach(() => {
        _resetPipelineForTesting();
        // bge-m3 produces 1024-dim vectors
        vi.mocked(pipeline).mockResolvedValue(
            fakePipeline(SEMANTIC_MODELS['bge-m3'].dim) as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
    });

    afterEach(() => {
        _resetPipelineForTesting();
        vi.clearAllMocks();
    });

    it('loads bge-m3 hub model', async () => {
        const embedder = makeEmbedder('bge-m3');
        await embedder.embed(['hello']);
        expect(pipeline).toHaveBeenCalledWith('feature-extraction', SEMANTIC_MODELS['bge-m3'].hubId);
    });

    it('calls extractor with { pooling: "cls", normalize: true }', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['bge-m3'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('bge-m3');
        await embedder.embed(['cls-pooling test']);
        expect(fakeExtractor).toHaveBeenCalledWith(
            expect.anything(),
            { pooling: 'cls', normalize: true },
        );
    });

    it('returns 1024-dim vectors for bge-m3', async () => {
        const embedder = makeEmbedder('bge-m3');
        const result = await embedder.embed(['dimension check']);
        expect(result[0]).toHaveLength(SEMANTIC_MODELS['bge-m3'].dim);
    });

    it('caches bge-m3 pipeline separately from minilm pipeline', async () => {
        // Set up distinct mocks for each alias call sequence
        vi.mocked(pipeline)
            .mockResolvedValueOnce(fakePipeline(384) as unknown as Awaited<ReturnType<typeof pipeline>>)  // minilm
            .mockResolvedValueOnce(fakePipeline(1024) as unknown as Awaited<ReturnType<typeof pipeline>>); // bge-m3

        // First call each alias once
        await embed(['minilm text']);
        const bgeEmbedder = makeEmbedder('bge-m3');
        await bgeEmbedder.embed(['bge text']);

        // pipeline() was called once per alias = 2 total
        expect(pipeline).toHaveBeenCalledTimes(2);

        // Second call to each alias should use cache — no new pipeline() calls
        await embed(['minilm second']);
        await bgeEmbedder.embed(['bge second']);
        expect(pipeline).toHaveBeenCalledTimes(2);
    });

    it('mode is a no-op for bge-m3 (no prefix configured)', async () => {
        const fakeExtractor = fakePipeline(SEMANTIC_MODELS['bge-m3'].dim);
        vi.mocked(pipeline).mockResolvedValue(
            fakeExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
        );
        const embedder = makeEmbedder('bge-m3');
        await embedder.embed(['hello'], 'passage');
        await embedder.embed(['hello'], 'query');
        // Both modes pass the raw text unchanged — no prefix
        const calls = fakeExtractor.mock.calls;
        expect(calls[0][0]).toEqual(['hello']);
        expect(calls[1][0]).toEqual(['hello']);
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

    it('caches e5-base pipeline separately from minilm and bge-m3', async () => {
        vi.mocked(pipeline)
            .mockResolvedValueOnce(fakePipeline(384) as unknown as Awaited<ReturnType<typeof pipeline>>)   // minilm
            .mockResolvedValueOnce(fakePipeline(1024) as unknown as Awaited<ReturnType<typeof pipeline>>)  // bge-m3
            .mockResolvedValueOnce(fakePipeline(768) as unknown as Awaited<ReturnType<typeof pipeline>>);  // e5-base

        await embed(['minilm text']);
        await makeEmbedder('bge-m3').embed(['bge text']);
        await makeEmbedder('e5-base').embed(['e5 text']);

        // Each alias needs one pipeline init
        expect(pipeline).toHaveBeenCalledTimes(3);

        // Second calls should all hit cache
        await embed(['minilm second']);
        await makeEmbedder('bge-m3').embed(['bge second']);
        await makeEmbedder('e5-base').embed(['e5 second']);
        expect(pipeline).toHaveBeenCalledTimes(3);
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
        const calls = fakeExtractor.mock.calls;
        expect(calls[0][0]).toEqual(['hello']);
        expect(calls[1][0]).toEqual(['hello']);
    });
});
