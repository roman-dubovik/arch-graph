/**
 * Lazy singleton tokenizer for the embedder model.
 *
 * Loads only the tokenizer (small JSON, ~5 MB), not the 384-dim model weights.
 * Used by docs chunking (`markdown-split.ts`) and any future code that needs to
 * size content against the embedder's BERT-style context (native 128 tokens
 * for paraphrase-multilingual-MiniLM-L12-v2).
 *
 * DO NOT use `@dqbd/tiktoken` for embedder chunking — that's cl100k_base
 * (Claude's tokenizer); the embedder uses XLM-RoBERTa SentencePiece, and the
 * counts disagree by 20-40% on Cyrillic/multilingual text.
 */
import { AutoTokenizer } from '@xenova/transformers';

import { SEMANTIC_MODEL } from './types.js';

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
let cached: Tokenizer | null = null;

export function _resetTokenizerForTesting(): void {
    cached = null;
}

async function getTokenizer(): Promise<Tokenizer> {
    if (cached === null) {
        cached = await AutoTokenizer.from_pretrained(SEMANTIC_MODEL);
    }
    return cached;
}

export async function countTokens(text: string): Promise<number> {
    const tk = await getTokenizer();
    const enc = tk.encode(text);
    if (Array.isArray(enc)) return enc.length;
    return (enc as { input_ids: number[] }).input_ids.length;
}
