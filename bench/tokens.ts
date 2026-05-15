// Tiny tiktoken wrapper. We use the `cl100k_base` encoding (the encoding used
// by gpt-4 / gpt-3.5-turbo / gpt-4-turbo / gpt-4o family). It's a reasonable
// "industry-standard" yardstick for context-token counts, and matches what
// most LLM-as-RAG-consumer code on the planet uses today.
//
// Note: we encode_ordinary() rather than encode(), because our inputs are
// just compact JSON strings — no special tokens, no chat-template overhead.

import { get_encoding, type Tiktoken } from '@dqbd/tiktoken';

let cached: Tiktoken | null = null;

function enc(): Tiktoken {
    if (!cached) cached = get_encoding('cl100k_base');
    return cached;
}

export function countTokens(text: string): number {
    if (!text) return 0;
    return enc().encode_ordinary(text).length;
}

/** Free the wasm-backed encoder. Call once at program exit. */
export function disposeTokens(): void {
    if (cached) {
        cached.free();
        cached = null;
    }
}
