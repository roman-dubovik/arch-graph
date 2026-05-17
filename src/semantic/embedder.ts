/**
 * Thin wrapper around @xenova/transformers that provides a stable, lazy-loaded
 * singleton pipeline. The model is never downloaded until the first call to
 * `embed()` or `embedOne()` — callers that never invoke embedding pay zero cost.
 *
 * Model contract (locked for 2-brain federation):
 *   Xenova/paraphrase-multilingual-MiniLM-L12-v2 — 384-dim, multilingual ONNX.
 *
 * Batch size guidance: 32 (safe default). Profile on larger graphs if needed.
 */
import { pipeline } from '@xenova/transformers';

import { SEMANTIC_MODEL } from './types.js';

// Module-private singleton. Lazily initialised on first embed call.
// No global state leaks outside this module.
let pipelineInstance: Awaited<ReturnType<typeof pipeline>> | null = null;

/** @internal — exposed for testing only; do not call in production code. */
export function _resetPipelineForTesting(): void {
    pipelineInstance = null;
}

async function getPipeline(): Promise<Awaited<ReturnType<typeof pipeline>>> {
    if (pipelineInstance === null) {
        // Downloads ~135 MB on first run; cached to ~/.cache/huggingface/...
        // or $HF_HOME if set. Subsequent calls are instant.
        console.error(`[arch-graph semantic] Loading model ${SEMANTIC_MODEL} (one-time download, will cache)...`);
        pipelineInstance = await pipeline('feature-extraction', SEMANTIC_MODEL);
    }
    return pipelineInstance;
}

/**
 * Embed a batch of texts. Returns one float32 vector per input string.
 * Vectors have length 384.
 */
export async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await getPipeline();
    const output = await (extractor as (input: unknown, opts: unknown) => Promise<{ tolist(): number[][] }>)(texts, { pooling: 'mean', normalize: true });
    // output.tolist() returns number[][] for batch inputs
    return output.tolist();
}

/**
 * Embed a single text string. Returns a float32 vector of length 384.
 */
export async function embedOne(text: string): Promise<number[]> {
    const results = await embed([text]);
    return results[0];
}
