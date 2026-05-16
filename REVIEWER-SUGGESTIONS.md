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

### Block B — HTTP extractor

- **[nice-to-have] [http] `AXIOS_CREATE_RE` поддерживает только depth-1 nested parens** — после cleanup-http регулярка хендлит `axios.create({ baseURL: getUrl() }).get(url)`, но `axios.create({ baseURL: build(getUrl()) })` (depth-2) всё ещё мисс. AST extractor ловит, regex GT — нет → false `extra` в diagnostics. Не recall miss, не gate failure. Решение: brace/paren-balanced регулярка или рекурсивный паттерн. На корпусе пока 0 кейсов depth ≥ 2.

### Block C — TS-imports extractor

- **[nice-to-have] [imports] mapper `else` branch без `never`-guard на `TsImportResolution`** — `src/mapper/imports-to-graph.ts` обрабатывает `resolved` / `external` / `dynamic-non-literal` явно, остальное (`broken-alias`, `broken-relative`) уходит в `else`. Если добавится 6-й variant — он молча упадёт в `unresolvedInternal`. Лоу-приоритет, тип-дизайн ОК. (type-design-analyzer, cleanup-imports-resolution re-review)

- **[nice-to-have] [imports] `dynamic-non-literal` структурно не привязан к `kind: 'dynamic'`** — variant может появиться на `kind: 'static'` сайте формально валидно. На практике extractor так не делает, но тип не enforced. (type-design-analyzer, cleanup-imports-resolution)

### Block D — Mermaid output

- **[nice-to-have] [mermaid] dedup-comment в collision aggregation** — inline comment на ~line 101 говорит "same sanitizedId + same originalIds set", но dedup ключ только по `sanitizedId`. Лёгкое уточнение текста. (comment-analyzer, cleanup-mermaid-collisions)

### Block F — MCP server

- **[convention] [mcp] `EdgeAnswer.role` + `kind` независимы — design decision** — в `NatsCallSite` они структурно сцеплены через DU, в `EdgeAnswer` — отдельные поля. Документировано в комментарии. (type-design convergence, conscious deviation)

- **[nice-to-have] [mcp] JSDoc на never-default-arm в `query` switch** — после cleanup-mcp-exhaust default arm с `const _: never = action` есть, но без JSDoc. Будущий разработчик может принять за dead code. Стилевое улучшение. (pr-review-toolkit, cleanup-mcp-exhaust)

### Cross-cutting

- **[nice-to-have] [cli] `appendBlock` JSDoc неточен** — JSDoc говорит "Adds trailing newline", но trailing newline должен быть в самом `block` параметре, не добавляется функцией. Pre-existing неточность, унаследовано из claude.ts. (comment-analyzer, cleanup-marker-block)

---

## Закрыто в cleanup/axios-taint 2026-05-16

- **[feature-suggestion] [http] `axios.create()` client variable tracking** — deferred, no corpus signal.
  Паттерн `const client = axios.create({ baseURL }); client.get(path)` не реализован.
  Corpus check (2026-05-16) по 5 reference-проектам:
  beribuy2=0, insyra=0, platform=1 (без `baseURL`, только `timeout`/`headers`), screenia=0, unpacks=0.
  Итого: 0 сайтов с `baseURL` → реализация даст 0 новых resolved URL.
  Реактивировать при появлении проекта использующего `axios.create({ baseURL })`.
  (feature-suggestion, cleanup/axios-taint; см. комментарий в extractor.ts)

---

## Закрыто в cleanup-passе 2026-05 (для архива)

Все исходные 8 пунктов из ранжирования Тиер 1–3 закрыты в серии cleanup/* PR’ов:

- **Block A** `DiProviderRef.token.providerKind: 'unknown'` → **token-ref variant** (003d348)
- **Block B** `HttpDiagnostics.externalCalls` → **informational** (f6149b7)
- **Block B** `.endsWith('.create')` over-match → AST structural check (f6149b7)
- **Block B** `AXIOS_CREATE_RE` nested parens → depth-1 fix (f6149b7)
- **Block C** `TsImportSite.resolvedFilePath: string | null` → `TsImportResolution` DU (54e4151)
- **Block D** `buildIdMap` collisions → `mermaid-collisions.json` artifact (7f00082)
- **Block E** `BullMqQueueRef.unresolved.reason` → 6-variant DU (44b7b30)
- **Block F** `RoutedAction` switch never-arm exhaustiveness → added (76aa016)
- **Cross-cutting** marker-block helpers → `src/cli/marker-block.ts` (41915ac, aad1bc5)

---

## Политика

Перед закрытием каждого блока:
1. Все critical+important pr-review findings — fix + re-review до 0.
2. Все остальные — сюда, в этот файл.
3. После всех блоков — общее ранжирование, выбор top-N для следующей итерации.
