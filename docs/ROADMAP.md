# arch-graph roadmap

Дата: 2026-05-17. Цель этого документа — отразить **что есть сейчас**, **что отложено** и **что под вопросом**.

## Где мы сейчас

**Pipeline**: TypeScript-monorepos → ts-morph extractors → `graph.json` + optional semantic sidecar (`embeddings.jsonl` + `manifest.json`).

**Semantic layer** (MiniLM-L12-v2, 384-dim) поверх 17 NodeKinds. На 17 мая 2026 — пять подряд апдейтов.

| Тэг | Что | Шипнуто |
|---|---|---|
| `doc-section-v1` | Markdown секции как ноды графа, индексируются вместе с кодом | ✅ |
| `code-vs-docs-v1` | MCP-tools `code_search` + `docs_search` — устраняют дилюцию кода документами | ✅ |
| `ui-uplift-v1` | fe-component snippet расширен JSX/className токенами + i18n строки в embed-text | ✅ |
| `openapi-enrich-v1` | OpenAPI YAML описания привязываются к endpoint-нодам (по operationId или method+path) | ✅ |
| `fe-i18n-multi-enum-v1` | Multi-file locales (`locales/<lang>/<feature>.json`) + резолв TS enum в `@Controller`/`@Get` | ✅ |

**Recall (103 запроса × 3 проекта, both-buckets, K=10):**
- Старт сессии (single, K=5): 47%
- После code-vs-docs split: 67% (+20pp)
- После UI uplift + OpenAPI + locales-multi + enum-resolver + `*.md` glob: финальные числа замеряются (eval `b0ebgp50l` крутится)

## Что отложено по результатам эвала

### v2 doc-mentions edges — НЕ нужно

Решение принято после замера D_links = 100%. Single-shot RAG достаточно. Edges дадут разве что explainability — но не recall.

### UI category (C_ui) — упёрлись в потолок текущего embedder'а

Замерили: Task A (classes-block в сниппете) + Task B (i18n) технически работают, но C_ui не сдвинулся с 33-50%. Корень — линговый gap MiniLM: «обрезать сообщение в 3 точки» (RU) не маппится на «truncate» / «text-ellipsis» (EN Tailwind). Snippet-токены есть в индексе, embedder не строит мост.

Следующие шаги UI описаны ниже в разделе «Стратегические опции».

## Стратегические опции — что дальше

### 🟢 1. BGE-M3 миграция (приоритет 1)

**Что**: замена embedder'а с MiniLM-L12 (384-dim) на bge-m3 (1024-dim). Лучший RU/multilingual.

**Зачем**: единственное направление с прогнозом ощутимого прироста (+5-10pp overall, особенно C_ui и RU-only запросы). Design-док уже есть в `2-brain/docs/plans/2026-05-17-embedder-bge-m3-migration-analysis.md`.

**Сложность**: 1-2 дня. Нужно перестроить все semantic-индексы (one-time migration). Бэк-compat path есть через manifest.model field.

**Риски**: 4× память на вектор. Производительность поиска линейна по размерности — увеличится но в пределах нормы.

### 🟡 2. CSS processing для UI (под вопросом)

**Что**: индексировать CSS / Tailwind семантику. Три варианта рассматриваются в `docs/research/2026-05-17-css-processing-feasibility.md` (когда агент закончит):
- α) Tailwind utility expansion (`text-right` → «text-align right»)
- β) Per-class RU synonym dictionary
- γ) Real CSS file parsing

**Ожидание**: BGE-M3 может сделать это ненужным. Если BGE-M3 поднимет C_ui до 50%+, эта работа лишняя.

**Решение**: ждём BGE-M3 → меряем → если C_ui всё ещё <50%, тогда CSS processing.

### 🟡 3. Hybrid BM25 + semantic (отложено)

**Что**: лексический BM25-сигнал поверх семантики. Точный match для terms типа «truncate», «refresh».

**Сложность**: 3-5 дней, архитектурная работа.

**Решение**: после BGE-M3, по результатам. Маловероятно понадобится.

### 🟡 4. project-c-specific extractor доводки

**Что**: enum-resolver уже шипнут (главный win). Остался один pain — eval-queries (`B1`, `B4`, `B8`) ссылаются на cart/payment/delivery которых нет в project-c (это аггрегатор промокодов). Это **проблема корпуса**, не arch-graph.

**Решение**: eval hygiene — переписать B1/B4/B8 под фактический домен project-c (промокоды/блог). Это ~30 минут работы, но НЕ ROI на recall ANY других проектов.

### ⚪ 5. Дополнительные NodeKinds под спрос

- GraphQL endpoints (если проекты их используют)
- Cron schedule semantics
- Background jobs (BullMQ Processor уже есть, можно расширить)

Делается по запросу. Каждый extractor +1-2 дня.

## Тесты и бенчмарки — durable comparison baseline

Сейчас результаты живут в `scripts/eval/results-2026-05-17-{single,per-category,fallback,both-buckets}.md`. Это апплз-ту-апплз снимки во времени.

**Что улучшим (в работе)**:
- `BENCHMARKS.md` — durable single-page-summary с табличкой baseline-numbers для каждой шипнутой фичи. Будет обновляться при каждом тэге.
- Eval-скрипт уже принимает `EVAL_MODE` и `EVAL_K` env. Можно зафиксировать конкретные run-конфиги для сравнения после смены embedder'а.

## Известные ограничения (честно)

- **Static extraction** — не видим runtime config, container env, динамически-построенные identifier'ы. Зафиксировано в `diagnostics.json`.
- **C_ui recall ceiling 33-50%** — ограничено embedder'ом. Tasks A+B шипнуты но не двинули числа.
- **project-c A_find 30%** — после enum-resolver должно подняться (мы измерим в текущем eval'е). До этого был block'ан энумами.
- **i18n project-specificity** — поддерживаем `messages/*.json` + `locales/<lang>/*.json` (single + multi-file). Проекты с экзотическими паттернами (`react-intl` ICU bundles, server-side `[[lang]]/messages.po`) пока не поддерживаются.

## Open questions (требуют решения пользователя)

1. **BGE-M3 — когда?** Готовы выделять 1-2 дня? Это next-priority по матрице ROI.
2. **eval hygiene на project-c** — переписать ли B1/B4/B8 или оставить как есть для исторической чистоты сравнения?
3. **Дополнительные проекты в эвал-наборе?** Сейчас project-a/project-b/project-c — это 3 NestJS-проекта. Может пора добавить Node-monolith или GraphQL-проект для большего покрытия?

## Шипнутые планы (архив)

Все `v_*.md` в `docs/plans/` — реализованы. См. соответствующие коммиты в git log.
