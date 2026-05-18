/**
 * Lazy per-alias tokenizer cache for the embedding models.
 *
 * Loads only the tokenizer (small JSON, ~5 MB), not the model weights.
 * Used by docs chunking (`markdown-split.ts`) and any code that needs to
 * size content against the embedder's BERT-style context window.
 *
 * Per-alias cache: each supported alias ('minilm', 'e5-base') has its own
 * tokenizer instance because the models use different vocabularies.
 * For e5-base, BERT-style token counts from minilm can diverge on
 * multilingual text — always use the matching tokenizer.
 *
 * DO NOT use `@dqbd/tiktoken` for embedder chunking — that's cl100k_base
 * (Claude's tokenizer); embedding models use XLM-RoBERTa SentencePiece /
 * BERT wordpiece tokenizers, and the counts disagree significantly on
 * Cyrillic/multilingual text.
 */
import { AutoTokenizer } from '@xenova/transformers';

import type { SemanticModelAlias } from './types.js';
import { SEMANTIC_MODELS } from './types.js';

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;

/** Per-alias pending promise cache. */
const pendingMap = new Map<SemanticModelAlias, Promise<Tokenizer>>();

export function _resetTokenizerForTesting(): void {
    pendingMap.clear();
}

function getTokenizer(alias: SemanticModelAlias): Promise<Tokenizer> {
    const cached = pendingMap.get(alias);
    if (cached !== undefined) return cached;
    const hubId = SEMANTIC_MODELS[alias].hubId;
    const p = AutoTokenizer.from_pretrained(hubId);
    pendingMap.set(alias, p);
    return p;
}

/**
 * Count tokens in `text` using the tokenizer for the given model alias.
 *
 * The alias is required: using the wrong tokenizer silently produces incorrect
 * chunk sizes. Pass the resolved alias from the active build or search config.
 */
export async function countTokens(text: string, alias: SemanticModelAlias): Promise<number> {
    const tk = await getTokenizer(alias);
    const enc = tk.encode(text);
    if (Array.isArray(enc)) return enc.length;
    return (enc as { input_ids: number[] }).input_ids.length;
}
