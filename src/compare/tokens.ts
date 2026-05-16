// Tiny tiktoken wrapper. We use the `cl100k_base` encoding (the encoding used
// by gpt-4 / gpt-3.5-turbo / gpt-4-turbo). gpt-4o family uses `o200k_base` —
// the two encodings tokenize most prose comparably, but gpt-4o is ~10% denser
// on code-heavy text. Treat the absolute token counts here as a `gpt-4` /
// `claude` yardstick; for a gpt-4o-specific number swap in `o200k_base`.
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
