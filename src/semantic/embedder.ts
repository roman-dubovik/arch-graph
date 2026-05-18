/**
 * Thin wrapper around @xenova/transformers that provides stable, lazy-loaded
 * per-model pipelines.  The model is never downloaded until the first call to
 * `embed()` or `embedOne()` (or a factory-produced function) — callers that
 * never invoke embedding pay zero cost.
 *
 * Supported models (via SEMANTIC_MODELS registry in types.ts):
 *   minilm  — Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384-dim, mean pooling
 *   bge-m3  — Xenova/bge-m3, 1024-dim, CLS pooling
 *   e5-base — Xenova/multilingual-e5-base, 768-dim, mean pooling, requires prefix
 *
 * For e5-base (and any future prefix-requiring model), the `mode` parameter
 * controls which prefix is applied:
 *   'passage' (default) — prepends `entry.prefix.passage` to each text (for build)
 *   'query'             — prepends `entry.prefix.query` to each text (for search)
 *
 * For minilm/bge-m3, `mode` is a no-op (no prefix required).
 *
 * Batch size guidance: 32 (safe default). Profile on larger graphs if needed.
 */
import { pipeline } from '@xenova/transformers';

import type { EmbedMode, SemanticModelAlias } from './types.js';
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
    // Models that ship without the standard `model_quantized.onnx` file (e.g.
    // Arctic v2 has model.onnx + model_int8.onnx + model_q4.onnx etc but no
    // `_quantized`) must explicitly opt out of the default quantized lookup.
    // For models that DON'T need the opt-out, pass the 2-arg form so existing
    // pipeline-call assertions (toHaveBeenCalledWith(...)) keep matching.
    const instance = entry.quantized === false
        ? await pipeline('feature-extraction', entry.hubId, { quantized: false })
        : await pipeline('feature-extraction', entry.hubId);
    pipelineCache.set(alias, instance);
    return instance;
}

/** Signature of the batch embedder expected by `BuildSemanticOpts.embedder`. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Object returned by `makeEmbedder`. Exposes both passage and query modes.
 *
 * - `embed(texts, mode?)` — embed a batch of texts; `mode` defaults to `'passage'`.
 * - `embedOne(text, mode?)` — embed a single text; `mode` defaults to `'passage'`.
 *
 * For models without a prefix (minilm, bge-m3), `mode` is accepted but has no
 * effect — prefix is undefined and no prepend is performed.
 */
export interface Embedder {
    embed(texts: string[], mode?: EmbedMode): Promise<number[][]>;
    embedOne(text: string, mode?: EmbedMode): Promise<number[]>;
}

/**
 * Create an embedder bound to a specific model alias.
 * Returns an {@link Embedder} object exposing both passage and query modes.
 *
 * @example
 *   // Builder (passage mode):
 *   const e = makeEmbedder('e5-base');
 *   const vecs = await e.embed(['hello world'], 'passage');
 *
 *   // Search (query mode):
 *   const q = await e.embedOne('find auth flow', 'query');
 */
export function makeEmbedder(alias: SemanticModelAlias): Embedder {
    const entry = SEMANTIC_MODELS[alias];

    async function embedWithMode(texts: string[], mode: EmbedMode = 'passage'): Promise<number[][]> {
        if (texts.length === 0) return [];

        // Apply prefix if the model requires one for this mode.
        let inputs: string[] = texts;
        if (entry.prefix) {
            const p = mode === 'query' ? entry.prefix.query : entry.prefix.passage;
            inputs = texts.map((t) => `${p}${t}`);
        }

        const extractor = await getPipeline(alias);
        const output = await (
            extractor as (input: unknown, opts: unknown) => Promise<{ tolist(): number[][] }>
        )(inputs, { pooling: entry.pooling, normalize: entry.normalize });
        return output.tolist();
    }

    return {
        embed: embedWithMode,
        async embedOne(text: string, mode: EmbedMode = 'passage'): Promise<number[]> {
            const results = await embedWithMode([text], mode);
            return results[0]!;
        },
    };
}

/**
 * Embed a batch of texts using the default MiniLM model.
 * Returns one float32 vector per input string (length 384).
 *
 * @deprecated Prefer `makeEmbedder('minilm').embed(texts)` for explicit model selection.
 */
export const embed: EmbedFn = (texts: string[]) => makeEmbedder('minilm').embed(texts);

/**
 * Embed a single text string using the default MiniLM model.
 * Returns a float32 vector of length 384.
 *
 * @deprecated Prefer `makeEmbedder('minilm').embedOne(text)`.
 */
export async function embedOne(text: string): Promise<number[]> {
    return makeEmbedder('minilm').embedOne(text);
}
