# arch-graph — отложенные предложения ревьюеров

Сюда складываются **не-критичные** находки pr-review-toolkit, которые не блокируют relase, но достойны проработки. Все critical / important findings фиксятся немедленно (см. commit history).

Формат записи:
- **[severity] [domain] short title** — описание + (file:line) + почему отложено + кем предложено (агент / блок ревью).

Severity:
- `nice-to-have` — улучшение без явного blast radius (читаемость, чуть лучшая абстракция)
- `refactor` — рефактор без поведенческих изменений, но дороже одного-двух правок (требует обсуждения)
- `feature-suggestion` — новая функциональность поверх текущей (новый extractor / новый pattern / новая опция)
- `convention` — стилистическое / соглашение

Каждое предложение прежде чем закрывать — ранжируется по `impact × cost` совместно.

---

## Block A — DI extractor

- **[nice-to-have] [di] `DiProviderRef.token.providerKind: 'unknown'` is a low-signal escape hatch** — попадает в граф как `provider:<token>` с `providerKind=unknown` meta. Можно или удалить `'unknown'` совсем (и эти случаи отправлять в `unresolved`), или гарантировать, что `providerKind=unknown` всегда сопровождается `provideToken` (т.е. это просто string token без useX). Отложено — требует прохода по корпусу с подсчётом, насколько часто такая форма встречается. (type-design-reviewer, Block A merge)

## Block B — HTTP extractor

- **[nice-to-have] [http] separate `HttpDiagnostics.externalCalls` is the first positive-classification array** — все остальные domain-diagnostics массивы (`unresolved`, `unowned`) — это «не получилось». `externalCalls` напротив — «получилось, но классифицировано как external». Возможно, имеет смысл выделить отдельную структуру `HttpDiagnostics.informational: { externalCalls: HttpCallSite[]; ... }` для positive-классификаций и `diagnostics: { unresolved: ...; unowned: ... }` для проблем. (type-design-reviewer, Block B merge)
- **[feature-suggestion] [http] `axios.create()` client variable tracking** — сейчас inline `axios.create({...}).get(url)` детектится как unresolved, но `const client = axios.create({baseURL}); client.get(path)` не отслеживается. Полноценная реализация требует таинт-анализа (привязка `baseURL` к переменной). Отложено — паттерн рядкий, на корпусе пока 0 site’ов. (silent-failure-hunter, C2 fix follow-up)
- **[nice-to-have] [http] `AXIOS_CREATE_RE` пропускает nested parens** — `[^)]*` не матчит `axios.create({ baseURL: getUrl() }).get(url)`. AST extractor ловит, regex GT нет → false `extra` в diagnostics (не recall miss, не gate failure). Документировано в комментарии. Можно поднять регулярку до brace/paren-balanced формы при необходимости. (silent-failure-hunter re-review, edge case)
- **[nice-to-have] [http] `.endsWith('.create')` over-match** — extractor.ts ~line 135 ловит ЛЮБОЙ `foo.create().get(url)`, не только `axios.create()`. Для не-axios кейсов (`dataSource.create(...).get(id)`) сайт уйдёт в unresolved, GT не сматчит → false `extra`. Низкая частота, не влияет на recall. (code-reviewer re-review)

## Block C — TS-imports extractor

- **[nice-to-have] [imports] `TsImportSite.resolvedFilePath: string | null` collapses two cases** — `null` сейчас означает и «external (node_modules)», и «alias broken / typo». `specifierShape` различает их пост-фактум, но потребитель должен помнить связку. Type-guard helper `isResolvedToFile(site): site is TsImportSite & { resolvedFilePath: string }` или sum-type `resolution: { kind: 'resolved'; path } | { kind: 'external' } | { kind: 'broken-alias'; reason }` — оба путя обсудимы. Отложено — текущая форма не ломает контракт, исправление чисто эргономическое. (type-design-reviewer, Block C merge)

## Block D — Mermaid output

- **[refactor] [mermaid] `buildIdMap` collisions report → file rather than stderr** — сейчас warning при collision уходит в stderr, оператор видит только если внимательно читает лог. Можно дополнительно записать `mermaid-collisions.json` рядом с `graph.mermaid`, чтобы факт коллизии оставался в артефактах сборки. Отложено — на 5 проектах коллизий 0; добавлять I/O имеет смысл когда хотя бы один кейс встретился. (silent-failure-hunter, I12 fix follow-up)

## Block E — BullMQ + dedup (Phase 2 baseline)

- **[nice-to-have] [bullmq] `reason?: string` on unresolved BullMqQueueRef** — non-exported queue-name constants currently go to diagnostics without a structured reason. Predлагали добавить `reason: 'non-exported-const' | 'dynamic-expression'`. Отложено — паттерн редкий, на 5 проектах не встретился. (silent-failure-hunter, цикл BullMQ Phase 2 followup)

## Cross-cutting

_заполняется по ходу ревью_

---

## Политика

Перед закрытием каждого блока:
1. Все critical+important pr-review findings — fix + re-review до 0.
2. Все остальные — сюда, в этот файл.
3. После всех блоков — общее ранжирование, выбор top-N для следующей итерации.
