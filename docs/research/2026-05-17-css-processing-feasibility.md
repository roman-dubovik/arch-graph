# CSS Processing Feasibility for C_ui Recall Uplift

**Date:** 2026-05-17
**Status:** Research only — no source modifications
**Context:** C_ui hit-rate stuck at 33–50%. Embedder is
`paraphrase-multilingual-MiniLM-L12-v2` (384-dim). Task A (Tailwind class tokens
in snippet) and Task B (i18n strings) have shipped and did NOT move C_ui. Root
cause hypothesis: the embedder cannot bridge the linguistic gap between a Russian
query («обрезать сообщение в 3 точки») and an English Tailwind atom (`truncate`).

---

## Option α — Tailwind Utility Expansion

**Approach.** When `buildClassesBlock` (`src/semantic/snippet.ts:492-510`) collects
className tokens, expand each token against a static Tailwind→CSS-property dictionary
and append the expansions to the embed text. E.g. `truncate` → `truncate (overflow:
hidden; text-overflow: ellipsis; white-space: nowrap)`. The hook point is
`buildEmbedText` in `src/semantic/builder.ts:259-290`, following the established
AC-B6 pattern (i18nStrings, lines 263-272): append to embed-text only, never to
snippet (per the comment at builder.ts:254-255). A static JSON map of ~150–200
common Tailwind utilities is sufficient; no runtime Tailwind config required.

| | |
|---|---|
| **Expected uplift** | ~0. Task A already ships bare EN tokens; α adds more English (`overflow: hidden` instead of `truncate`). The embedder's multilingual cross-lingual alignment is the bottleneck, not the choice between `truncate` and its CSS expansion. Inherits Task A's null result. |
| **Implementation effort** | 0.5–1 day (dictionary JSON, expansion helper, tests). |
| **Risk / failure mode** | Tailwind v3/v4 utility renames; dynamic class names via `cn()`/`clsx` are already excluded by `collectClassNameTokens`. No new architectural risk. |
| **Interaction with BGE-M3** | BGE-M3 does not help α — both α and BGE-M3 deal in English; α adds no new information the model could leverage even with better cross-lingual alignment. α is redundant in either world. |

---

## Option β — Per-Class Russian Synonyms Dictionary

**Approach.** Hand-curate a map from common Tailwind/CSS atoms to Russian visual
descriptions: `truncate` → `«обрезать многоточием»`, `text-right` →
`«выровнять по правому краю»`, `hidden` → `«скрыть»`, etc. After className tokens
are collected (same hook as α), look up each token and append any matching Russian
phrase to the embed text. Hook point is identical: `buildEmbedText` at
builder.ts:259, as a `cssRuSynonyms` block mirroring the `i18nStrings` append.

| | |
|---|---|
| **Expected uplift** | Moderate — this is the only option that targets the actual bottleneck. Putting Russian text adjacent to the English atom in the same embedding context directly closes the cross-lingual gap for covered tokens. Realistic uplift: +10–20 pp on C_ui for queries that use vocabulary in the dictionary. |
| **Implementation effort** | 1–2 days: 0.5 day plumbing, 1–2 days dictionary curation. Curation is the real cost and never fully ends — Tailwind adds new utilities with every minor. |
| **Risk / failure mode** | Coverage is bounded by dictionary size. Utility classes generated at runtime (`cn(prop ? 'truncate' : 'line-clamp-2')`) are invisible to the static extractor. Idiomatic Russian is subjective; a wrong synonym can hurt recall. |
| **Interaction with BGE-M3** | If BGE-M3 closes the RU↔EN gap at the model layer, β becomes largely redundant — the model already learns `truncate` ≈ «обрезать». If BGE-M3 is not pursued, β is the cheapest targeted fix. |

---

## Option γ — Real CSS File Parsing

**Approach.** Parse `*.css` / `*.module.css` files with a CSS parser (e.g. PostCSS)
and index class definitions as new graph nodes (`css-rule` NodeKind) or attach
them to the nearest `fe-component` via `meta` (following the `i18nStrings` precedent
in `src/extractors/fe/types.ts:32-39`). The new extractor would live alongside
`src/extractors/fe/extractor.ts`. Snippet extraction requires a new `case 'css-rule'`
in the `extractKindAwareSnippet` switch at `src/semantic/snippet.ts:86-121`. CSS
property names and values would be extracted and embedded: `.btn-primary { background:
blue; padding: 8px }` → `"btn-primary background blue padding"`.

| | |
|---|---|
| **Expected uplift** | ~0 for the targeted linguistic gap. CSS property names (`background-color`, `padding`) are English. For the `truncate` → «обрезать» query type, γ provides no additional signal beyond what α already fails to provide. Marginal uplift is possible only if CSS modules contain semantically rich class names (`.message-truncated`) that happen to match query vocabulary — rare in Tailwind codebases where modules are minimal. |
| **Implementation effort** | 3–5 days: PostCSS dependency, new NodeKind in `core/types.ts`, extractor, mapper, snippet case, diagnostics, tests, edge cases (`.module.css` vs global, CSS-in-JS exclusion). |
| **Risk / failure mode** | Tailwind shops rarely write meaningful hand-authored CSS — most rules are `@apply truncate` re-exports, which again land back on English Tailwind tokens. CSS-in-JS (styled-components, emotion) is out of scope by definition; gap is not flagged for the user. Highest cost, lowest payoff of the three options. |
| **Interaction with BGE-M3** | Same as α — BGE-M3 does not help γ. English-to-English expansion gains nothing from better cross-lingual alignment. |

---

## Ranking by ROI

| Rank | Option | Uplift | Effort | Verdict |
|------|--------|--------|--------|---------|
| 1 | **β** Russian synonyms | +10–20 pp (covered tokens) | 1–2 days | Best ROI if not doing BGE-M3 |
| 2 | **α** Tailwind expansion | ~0 | 0.5–1 day | Cheap but ineffective |
| 3 | **γ** CSS file parsing | ~0 | 3–5 days | Poor ROI, skip |

---

## Recommendation: BGE-M3 First

**BGE-M3 alone almost certainly beats any combination of α/β/γ.**

The root cause is the embedder's failure to align Russian query space with English
Tailwind atom space — a model-level problem. β addresses it with a brittle
dictionary; BGE-M3 addresses it universally with 1024-dim cross-lingual dense
representations that are trained explicitly to align multilingual semantics.

If BGE-M3 is done:
- α and γ are completely unnecessary.
- β becomes a minor fine-tuning aid (small boost for hyper-specific slang queries)
  but not worth maintaining.

If BGE-M3 is deferred or ruled out (e.g. memory/latency constraints on the embed
host), β is the correct investment: 1–2 days for a targeted +10–20 pp boost on
covered vocabulary. α and γ should be skipped regardless.

**Decision tree:**

```
Is BGE-M3 migration feasible in the near term?
  Yes → Do BGE-M3. Skip α/β/γ.
  No  → Do β (Russian synonyms). Skip α and γ.
```
