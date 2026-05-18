/**
 * Thin wrapper around @xenova/transformers that provides stable, lazy-loaded
 * per-model pipelines.  The model is never downloaded until the first call to
 * `embed()` or `embedOne()` (or a factory-produced function) — callers that
 * never invoke embedding pay zero cost.
 *
 * Supported models (via SEMANTIC_MODELS registry in types.ts):
 *   minilm  — Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384-dim, mean pooling
 *   bge-m3  — Xenova/bge-m3, 1024-dim, CLS pooling
 *
 * Batch size guidance: 32 (safe default). Profile on larger graphs if needed.
 */
import { pipeline } from '@xenova/transformers';

import type { SemanticModelAlias } from './types.js';
import { SEMANTIC_MODELS } from './types.js';

// Per-alias pipeline cache.  Lazily initialised on first embed call per alias.
// No global state leaks outside this module.
const pipelineCache = new Map<SemanticModelAlias, Awaited<ReturnType<typeof pipeline>>>();

/** @internal — exposed for testing only; do not call in production code. */
export function _resetPipelineForTesting(): void {
    pipelineCache.clear();
}

async function getPipeline(
    alias: SemanticModelAlias,
): Promise<Awaited<ReturnType<typeof pipeline>>> {
    const cached = pipelineCache.get(alias);
    if (cached !== undefined) return cached;

    const entry = SEMANTIC_MODELS[alias];
    // Downloads on first run; cached to ~/.cache/huggingface/... or $HF_HOME if set.
    // Subsequent calls are instant.
    console.error(
        `[arch-graph semantic] Loading model ${entry.hubId} (one-time download, will cache)...`,
    );
    const instance = await pipeline('feature-extraction', entry.hubId);
    pipelineCache.set(alias, instance);
    return instance;
}

/** Signature of the batch embedder expected by `BuildSemanticOpts.embedder`. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Create a batch embedder bound to a specific model alias.
 * Returns a function with signature `(texts: string[]) => Promise<number[][]>`.
 *
 * @example
 *   const embedder = makeEmbedder('bge-m3');
 *   const vectors = await embedder(['hello world']);
 */
export function makeEmbedder(alias: SemanticModelAlias): EmbedFn {
    const entry = SEMANTIC_MODELS[alias];
    return async function embedWithAlias(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const extractor = await getPipeline(alias);
        const output = await (
            extractor as (input: unknown, opts: unknown) => Promise<{ tolist(): number[][] }>
        )(texts, { pooling: entry.pooling, normalize: entry.normalize });
        return output.tolist();
    };
}

/**
 * Embed a batch of texts using the default MiniLM model.
 * Returns one float32 vector per input string (length 384).
 *
 * @deprecated Prefer `makeEmbedder('minilm')` for explicit model selection.
 */
export const embed: EmbedFn = makeEmbedder('minilm');

/**
 * Embed a single text string using the default MiniLM model.
 * Returns a float32 vector of length 384.
 *
 * @deprecated Prefer `makeEmbedder('minilm')` and call the result with a
 *   single-element array when you need a one-shot embedder.
 */
export async function embedOne(text: string): Promise<number[]> {
    const results = await embed([text]);
    return results[0];
}
