# arch-graph — отложенные предложения ревьюеров

Сюда складываются **не-критичные** находки pr-review-toolkit, которые не блокируют release, но достойны проработки. Все critical / important findings фиксятся немедленно (см. commit history).

Формат записи:
- **[severity] [domain] short title** — описание + (file:line) + почему отложено + кем предложено (агент / блок ревью).

Severity:
- `nice-to-have` — улучшение без явного blast radius (читаемость, чуть лучшая абстракция)
- `refactor` — рефактор без поведенческих изменений, но дороже одного-двух правок (требует обсуждения)
- `feature-suggestion` — новая функциональность поверх текущей (новый extractor / новый pattern / новая опция)
- `convention` — стилистическое / соглашение

Каждое предложение прежде чем закрывать — ранжируется по `impact × cost` совместно.

---

## Активные (deferred)

### Block F — MCP server

- **[convention] [mcp] `EdgeAnswer.role` + `kind` независимы — design decision** — в `NatsCallSite` они структурно сцеплены через DU, в `EdgeAnswer` — отдельные поля. Документировано в комментарии. Сознательное отступление, не bug. (type-design convergence, conscious deviation)

---

## Закрыто в cleanup-passе #2 (2026-05-16)

Все 7 nice-to-have из предыдущей итерации обработаны (6 реализованы, 1 deferred с corpus-обоснованием):

- **Block B** `AXIOS_CREATE_RE` depth-2 nested parens → **paren-balanced walker** (произвольная глубина) — `cleanup/axios-regex @ 8796b87`
- **Block B** `axios.create()` client variable tracking → **deferred с corpus-проверкой** (5/5 проектов: 0 sites с `baseURL`) — `cleanup/axios-taint @ 7396359` + комментарий в `src/extractors/http/extractor.ts`
- **Block C** mapper `else` без `never`-guard → **switch+never+stderr warning** — `cleanup/imports-tighten @ 4de6375`
- **Block C** `dynamic-non-literal` не привязан к `kind: 'dynamic'` → **TsStaticResolution / TsDynamicResolution split** — `cleanup/imports-tighten @ 4de6375`
- **Block D** Mermaid dedup-comment уточнение → исправлено — `cleanup/comments @ 3896398`
- **Block F** JSDoc на never-default-arm в MCP → добавлен — `cleanup/comments @ 3896398`
- **Cross-cutting** `appendBlock` JSDoc неточен → исправлен — `cleanup/comments @ 3896398`

---

## Закрыто в cleanup-passе #1 (2026-05)

Все исходные 8 пунктов из ранжирования Тиер 1–3 закрыты:

- **Block A** `DiProviderRef.token.providerKind: 'unknown'` → **token-ref variant** (003d348)
- **Block B** `HttpDiagnostics.externalCalls` → **informational** (f6149b7)
- **Block B** `.endsWith('.create')` over-match → AST structural check (f6149b7)
- **Block B** `AXIOS_CREATE_RE` nested parens (depth-1) → fix (f6149b7)
- **Block C** `TsImportSite.resolvedFilePath: string | null` → `TsImportResolution` DU (54e4151)
- **Block D** `buildIdMap` collisions → `mermaid-collisions.json` artifact (7f00082)
- **Block E** `BullMqQueueRef.unresolved.reason` → 6-variant DU (44b7b30)
- **Block F** `RoutedAction` switch never-arm exhaustiveness → added (76aa016)
- **Cross-cutting** marker-block helpers → `src/cli/marker-block.ts` (41915ac, aad1bc5)

---

## Out-of-scope (документировано отдельно)

- **D1–D6** в `05-deferred-patterns.md` — спекулятивные паттерны (object-literal-arg для не-bullmq доменов, conditional literal union etc.). Ждут реальных проектов в корпусе с этими паттернами.
- **Bench graphify-baseline** для 3 проектов (insyra/beribuy2/unpacks) — операционная задача (требует pre-built graphify-индексов на этих проектах), не code-change.
- **gRPC / Kafka / SQS / cross-monorepo** — extractor domains за пределами текущего scope (см. README "Limitations & honesty").

---

## Политика

Перед закрытием каждого блока:
1. Все critical+important pr-review findings — fix + re-review до 0.
2. Все остальные — сюда, в этот файл.
3. После всех блоков — общее ранжирование, выбор top-N для следующей итерации.
