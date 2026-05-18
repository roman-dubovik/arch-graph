# Test-awareness в arch-graph — brainstorm идей

_Дата: 2026-05-18. Статус: черновик-черновик, ничего не отгружено._

## Контекст

arch-graph сейчас не различает тесты и продакшен-код. Тесты получают эмбеддинги как любой другой `.ts`-файл, но в графе нет ни `test-suite` / `test-case` NodeKind, ни edge'ов «X тестируется Y», ни coverage-сигналов. Это пробел для LLM-агентских workflow'ов: запросы «как мы тестируем возврат» / «есть ли тест на UsersController.create» / «какие тесты сломаются если я поменяю поведение» сейчас либо не находят ничего, либо находят случайно через семантику.

Также: на трёх референсных монорепо (для 103-query бенча) мы делаем только `arch-graph build` + retrieval-бенч — тесты этих проектов **не запускаем и не используем**. То же про self-build: 1206 vitest-тестов внутри arch-graph, но в его графе они не отличимы от остального кода.

## Идеи по тирам

### Tier 1 — дёшево, высокий ROI (2–3 дня)

#### 1. `test-suite` / `test-case` NodeKind

Парсим `describe()` / `it()` / `test()` через ts-morph (как остальные extractors). Каждый `it(...)` — отдельный node:
- `label`: заголовок теста (строка из первого аргумента)
- `snippet`: тело callback'а (отличный материал для семантики — там полный setup-arrange-act-assert)
- `kind`: `test-case`
- Поддержать vitest / jest / playwright синтаксис (одни и те же AST-паттерны)

Запрос «как мы тестируем возврат» начинает находить именно тестовый сценарий с реальным setup-кодом.

#### 2. `tests-target` edge

Линкуем `test-case` → продакшен-узел двумя способами:
- **filename heuristic**: `users.controller.test.ts` ↔ `users.controller.ts` (cheap baseline)
- **import-trace**: что test-файл `import`-ит — то и тестирует (точнее, но требует резолва путей)

Запрос «есть ли тест на `UsersController.create`» — graph-traverse, не fuzzy-semantic. Точное «да/нет/количество тестов».

#### 3. `tests_search` MCP tool

Третий bucket рядом с уже отдельными `code_search` / `docs_search`. Та же причина что у docs split: bucket dilution. Тесты часто **самая ценная демонстрация** (полный setup), но в смешанной выдаче их вытесняет прод-код.

API: `tests_search({ query, k, kindFilters? })` → top-K test-case узлов.

### Tier 2 — coverage ingestion (1–2 дня, требует чтобы user реально гонял coverage)

#### 4. Coverage как атрибут на nodes

Парсим `coverage/lcov.info` или `coverage-final.json` (vitest/jest стандарт). Приклеиваем к prod-узлам:
```ts
coverage: { lines: 87, branches: 65, functions: 100 }
```
В диагностике видны hotspot'ы вроде «service с 12% line coverage».

#### 5. Test-gap diagnostics в `diagnostics.json`

- Модули с N source-файлами и 0 test-файлами
- Endpoint'ы без покрывающего integration-теста (нет test-case с `request(app).post('/path')` или эквивалент)
- E2E-suites покрывающие только happy-path (нет test-case с `expect(...).toThrow` или `4xx`-ожиданием)

Отчёт «untested surface area» — готовый артефакт для LLM или человека.

### Tier 3 — более тонкие сигналы (2–4 дня)

#### 6. Test-quality signals

Различать:
- Snapshot-only test (без `expect()` ассертов на поведение)
- Unit-only (нет integration-теста на тот же compositor)
- Mock-only (все depend'ы замокаются — не покрывает реальный flow)

Не для всех языков сразу, но в TS+vitest/jest вычислимо.

#### 7. Test-fixture / factory awareness

`createUser({...overrides})`, `mockOrderRepository()`, `userBuilder().withRole(...).build()` — обычно концентрированная демонстрация «как собрать объект типа X». Сейчас они смешиваются с прод-кодом. Отдельный `test-fixture` NodeKind делает их first-class находимыми.

#### 8. Reverse-traceability MCP tool: `tests_for(nodeId)`

Когда LLM редактирует prod-метод:
- **До** изменения — запрос `tests_for('endpoint:UsersController.create')` возвращает список covering test-case узлов
- **После** behavior change — тот же запрос даёт «тесты, которые надо обновить»

Поверх п.2 (`tests-target` edges) — один shot, без семантики.

### Tier 4 — спекулятивно

#### 9. Запуск тестов как сигнал

Прогон `pnpm test` на трёх референсных монорепо после `arch-graph build` мог бы дать дополнительную метрику — pass/fail rate, наличие flaky-tests. Скорее всего overkill для retrieval-tooling, не наша зона.

#### 10. `--target-tests` для `compare --share`

Дополнительный datapoint в анонимной share-payload: сколько test-узлов в каждом проекте, какая доля графа покрыта тестами. Социальная метрика для community.

## Что взять первым

**Tier 1 целиком (пункты 1–3)** — самый чистый winner:
- Точечный, scoped (`test-case` NodeKind по аналогии с уже сделанным `doc-section`)
- Не требует от пользователя ничего нового (тесты у них уже есть)
- Конкретный новый MCP tool (`tests_search`) — видимый user-facing value
- Дробится естественно: extractor → edges → MCP tool

**Tradeoff:** размер графа вырастет на 2–5× (тестов обычно много). Решается тем же `kindFilters`, что и docs — клиенты которым тесты не нужны фильтруют их на запросе.

## Связь с BGE-M3 migration

Если идём на BGE-M3 default — тестовый текст там тоже выиграет от лучшего эмбеддера. Связаны слабо, но порядок имеет смысл: **сначала Tier 1 test-awareness, потом BGE-M3 как default** (если решим переключать) — тогда оба обновления попадают в один re-bench.

## Открытые вопросы

1. Названия NodeKind: `test-case` (по аналогии с `doc-section`) или `it-block` / `test`? Голосую за `test-case`.
2. `describe`-блоки — отдельный `test-suite` NodeKind или просто префикс в `label` дочернего `test-case`? Простой вариант = префикс.
3. Хранить ли `it.skip` / `it.todo` как отдельный signal? Скорее да — это часть test-quality сигнала.
4. Snapshot-тесты — отдельная категория или подвид `test-case`? Дешевле начать с одной категории, потом разрезать.
5. Coverage ingestion (Tier 2) — формат: lcov / json-summary / json-coverage / istanbul? Скорее всего lcov как нижний общий знаменатель.

## Дорожная карта (если запускаем)

1. Дизайн-док `test-awareness-v1` (по образцу `doc-section-v1`, `code-vs-docs-v1`)
2. Tier 1 реализация: 3 коммита (extractor, edges, MCP tool)
3. Бенч: добавить test-targeted queries в `bench/self-build/queries-self-build.json` и в 103-query suite («где тестируется X», «есть ли тест на Y»)
4. Re-run head-to-head на трёх референсных монорепо — отдельный datapoint
5. Если recall растёт — Tier 2 coverage ingestion вторым шагом
