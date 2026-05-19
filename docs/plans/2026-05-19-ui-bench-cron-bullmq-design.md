# Design: UI alignment + head-to-head re-run + Cron/BullMQ extractors
Date: 2026-05-19

## Goal

Закрыть три независимых направления:
1. **UI fix** в `docs/index.html` — выровнять заголовки карточек по высоте там, где они «прыгают», и убрать визуальный сдвиг названия модели `multilingual-e5-base`.
2. **Head-to-head re-run** arch-graph vs graphify с текущим дефолтом `e5-base` + свежий graphify, обновить публичные цифры (Pages + comparison memo + BENCHMARKS).
3. **Cron + BullMQ extractors** — три отдельных тэга: `cron-v1`, `bullmq-extras-v1`, `bullmq-types-v1` (включая cross-enrichment между cron и BullMQ repeat).

## File-touch matrix

| Task | Files | Touches |
|------|-------|---------|
| **1 — UI alignment** | `docs/index.html` | CSS правило `.bench-card-label { min-height: ... }` либо inline; одна точка `multilingual-e5-base` (line 367) |
| **2a — Bench re-run (arch-graph)** | `scripts/eval/results-2026-05-19-both-buckets-e5-base.md` (новый), `scripts/eval/results-2026-05-19-both-buckets-en.md` (новый) | новые артефакты |
| **2b — Bench re-run (graphify side)** | `/tmp/graphify-eval-responses-2026-05-19.jsonl`, `/tmp/graphify-en-responses-2026-05-19.jsonl` | external artifacts (не в git) |
| **2c — Comparison memo update** | `docs/comparisons/2026-05-19-arch-graph-vs-graphify-eval.md` (новый, append-only memo per BENCHMARKS rule) | новый файл |
| **2d — Public numbers update** | `docs/index.html` (bench-card section 2 — lines 402-425 numbers), `docs/BENCHMARKS.md` (новая секция) | numbers + section |
| **3a — Cron extractor** | `src/extractors/cron-schedule/{extractor,scheduler-registry-index,constants}.ts` (новые), `src/mapper/cron-schedule-to-graph.ts` (новый), `src/validation/cron-schedule-validator.ts` (новый), `src/core/types.ts` (NodeKind + EdgeKind unions), `src/pipeline/build.ts` (wiring), `src/semantic/embed-text.ts` (cron-schedule embed text), `src/extractors/cron-schedule/*.spec.ts` + ground-truth fixtures | NEW EXTRACTOR |
| **3b — BullMQ Phase 1 extras** | `src/extractors/bullmq/extractor.ts` (extend ~80 LOC), `src/core/types.ts` (new EdgeKinds `queue-fails-into`, `queue-event-listener`; queue node meta), `src/mapper/bullmq-to-graph.ts` (если есть отдельно — иначе в extractor.ts), `src/extractors/bullmq/*.spec.ts` (новые тесты) | EXTEND |
| **3c — BullMQ Phase 2 + cross-enrichment** | `src/extractors/bullmq/job-data-types.ts` (новый, ts-morph type-checker), `src/extractors/bullmq/extractor.ts` (extend для worker scaling), `src/mapper/bullmq-to-graph.ts` (cross-link queue.repeat → cron-schedule), `src/extractors/cron-schedule/extractor.ts` (resolve repeat cron из BullMQ), новые тесты | EXTEND |

### Конфликты внутри matrix

| Конфликт | Решение |
|----------|---------|
| Task 1 vs Task 2d на `docs/index.html` | **Sequential.** Task 1 первым (CSS правка), Task 2d вторым (числа). |
| Task 3a vs Task 3b vs Task 3c на `src/core/types.ts` | **Sequential.** 3a → 3b → 3c. Каждый расширяет union строго на своих kinds. |
| Task 3a vs Task 3c на `src/extractors/cron-schedule/extractor.ts` | **Sequential.** 3c расширяет 3a (cron из BullMQ.repeat) — должен быть после 3a. |

### Параллелизация

- **Wave 1 (fast):** Task 1 (UI) — ~30 минут. После Wave 1 фиксируется `docs/index.html` baseline, чтобы Task 2d не конфликтовал.
- **Wave 2 (slow + medium):** Task 2 (bench re-run, фоновая) + Task 3a (Cron extractor) — разные файлы, конфликта нет. Task 2 — это в основном CPU-bound прогон, делает long-running агент.
- **Wave 3:** Task 3b — после 3a (types.ts).
- **Wave 4:** Task 3c — после 3b (types.ts) + 3a (cron-schedule node).
- **Wave 5:** Task 2d — обновить `docs/index.html` числами из Task 2 (по завершении bench).

## Patterns to follow

### Task 1 — UI

- Текущая структура карточек: `<div class="bench-card">` (или `bench-card highlight`) → `<p class="bench-card-label">TITLE</p>` → 2× `<p class="bench-card-row">…</p>` → `<p class="bench-card-foot">…</p>`.
- Текущая проблема: в head-to-head секции (lines 402-425) карточка 2 — `"Mean recall (substring-presence)"` (~33 chars) переносится на 2 строки, а соседние — 1 строка → ряды (`bench-card-row`, `bench-card-foot`) расходятся по высоте.
- **Fix:** добавить CSS правило `.bench-card-label { min-height: 2.6em; }` (или эквивалентное по высоте 2 строки текущего шрифта), либо `min-height` через `--card-label-min-height` CSS variable. **Альтернатива:** убрать перенос явно через `.bench-card-label { line-clamp: 2; }` или просто резервировать высоту через `&::after { content: "\200b\A"; }`.
- **Right-align модели:** строка 367 в `docs/index.html`:
  ```html
  <span class="bench-card-num mono" style="font-size:0.85em;">multilingual-e5-base</span>
  ```
  Добавить `white-space:nowrap; text-align:right;` (как сделано в строке 368 для `768 · cosine`). Если родительский `.bench-card-row` уже flex с `space-between`, достаточно `white-space:nowrap` — текст не должен переноситься.

### Task 2 — Head-to-head re-run

- **arch-graph side:** запустить `bash scripts/run-baseline-eval.sh` с переменными `MODEL=e5-base EVAL_MODE=both-buckets QUERIES_FILE=scripts/eval/queries.json PROJECT_A_DIR=… PROJECT_B_DIR=… PROJECT_C_DIR=…`. Артефакт — `scripts/eval/results-2026-05-19-both-buckets-e5-base.md`. Аналогично — для `queries-en.json`.
- **graphify side:** для каждого query в `queries.json` (и `queries-en.json`) пройти по 3 проектам, выполнить `graphify query "<text>" --budget 1500` из директории проекта, сложить ответы в `/tmp/graphify-{eval,en}-responses-2026-05-19.jsonl`. Скоринг — две метрики: lenient (substring anywhere в free-text response) + strict top-10 (как в memo от 2026-05-17, секция «Strict Apples-to-Apples»).
- **Скрипты скоринга** — переиспользовать те, что уже есть в репо. Если их нет — написать минимальный node-скрипт, опираясь на парсинг `NODE <label>` строк graphify stdout.
- **Memo:** новый файл `docs/comparisons/2026-05-19-arch-graph-vs-graphify-eval.md` со структурой, идентичной 2026-05-17 версии (TL;DR + RU table + EN strict re-score + caveats). По разделу «Strict-score sensitivity to graph mutation» — указать дату пересборки graphify графов.
- **Update публичных чисел:** `docs/index.html` lines 379-380 (RU `67% · 35%` → новые; EN strict `53.6% · 56.5%` → новые); `docs/BENCHMARKS.md` — новая секция «2026-05-19: e5-base vs fresh-graphify».

### Task 3a — Cron extractor (NEW)

- Зеркалировать структуру BullMQ extractor:
  - `src/extractors/cron-schedule/extractor.ts` — основная логика (~150-250 LOC):
    - Проход по классам, поиск декораторов `@Cron(…)`, `@Interval(…)`, `@Timeout(…)` (`@nestjs/schedule`).
    - Резолв аргументов: string literal (`'0 0 * * *'`), `CronExpression.X` enum reference, number (для @Interval/@Timeout).
    - Поиск динамической регистрации: `SchedulerRegistry.addCronJob(name, ...)` / `addInterval` / `addTimeout`.
  - `src/extractors/cron-schedule/scheduler-registry-index.ts` — pre-pass для динамических регистраций (~60-80 LOC).
  - `src/extractors/cron-schedule/constants.ts` — список декораторов + enum mapping `@nestjs/schedule`'s `CronExpression.EVERY_HOUR` → `'0 * * * *'` (~20 LOC).
- **NodeKind:** `'cron-schedule'`. Поля meta: `expression`, `resolvedExpression`, `humanReadable` (опционально, через `cronstrue`-like inline mapping — НЕ добавлять зависимость, только для известных CronExpression aliases), `category: 'cron' | 'interval' | 'timeout' | 'dynamic'`.
- **EdgeKind:** `'cron-triggers'` (cron-schedule → provider:method). Источник — провайдер-класс из same-class-decorator owner.
- **Mapper:** `src/mapper/cron-schedule-to-graph.ts` (~80-120 LOC). Создаёт ноды + ребра.
- **Validator:** `src/validation/cron-schedule-validator.ts` (~150-200 LOC). Ground-truth corpus (regex) по типу BullMQ-валидатора.
- **Pipeline wiring:** `src/pipeline/build.ts` — добавить блок после BullMQ (после line 248) и перед DI (line 249).
- **Semantic embed-text:** в `src/semantic/embed-text.ts` (или где сейчас формируется embed text для queue-нод) добавить кейс `'cron-schedule'`: `${kind} ${label} ${resolvedExpression} ${humanReadable ?? ''}`.
- **Tests:** ground-truth fixtures по образцу BullMQ — небольшой `.gt.ts` файл с примерами `@Cron('0 0 * * *')`, `@Cron(CronExpression.EVERY_HOUR)`, `@Interval(60000)`, `@Timeout(5000)`, `SchedulerRegistry.addCronJob`. Минимум 10 sites.

### Task 3b — BullMQ Phase 1 extras

- Расширить `src/extractors/bullmq/extractor.ts`:
  - В `buildProcessorSite()` читать `concurrency` из options-объекта (декоратор уже детектируется в lines 166-173, но значение не используется).
  - Аналогично — `defaultDelay`, `defaultAttempts`, `defaultBackoff` (из BullModule.registerQueue options).
  - `hasRepeat: boolean` — если в `.add(name, data, { repeat: ... })` или в registerQueue defaults есть `repeat`.
- **DLQ-эвристика (`queue-fails-into`):** если в processor есть `@Process` метод с `throw` + БДЛ-очередь в meta `failOver: 'other-queue-name'` (или паттерн `.failOver(...)` либо `.add('dlq-name', ...)` внутри catch-блока). Это эвристика — false-positive допустим, но flag в ground-truth.
- **Event listeners (`queue-event-listener`):** найти `queue.on('failed' | 'completed' | 'stalled', handler)` + `worker.on(...)`. Создать edge provider → queue.
- **Tests:** 6-8 новых spec, покрывающих happy path + edge для каждой добавки.

### Task 3c — BullMQ Phase 2 + cross-enrichment

- **Job-data types:** ts-morph type-checker pass. Для каждого `@Process` метода в processor:
  - Резолвить тип параметра `Job<DataType>` через `project.getTypeChecker()` или `node.getType()`.
  - Сохранять имя типа + поля (опционально — глубина 1, иначе слишком много данных) в meta queue node как `jobData: { typeName, fields: [...] }`.
  - Performance: type-checker может быть медленным. Опция — lazy compute только при `--types` флаге, иначе skip.
- **Worker scaling:** если worker создаётся фабрикой (например, `factory.createWorker(name, { concurrency: process.env.X ?? 5 })`), резолвить env-fallback default.
- **Cross-enrichment:** в Cron-extractor (или в BullMQ extractor) — если найден `queue.add(..., { repeat: { cron: '...' } })`, создавать cron-schedule node + edge `queue-repeat` (queue → cron-schedule). Cron-schedule node переиспользуется, если совпадает expression — но при первой имплементации можно создавать каждый раз отдельный node (deduplication — отдельный yak).
- **Tests:** 4-5 specs.

## External constraints

- **CLAUDE.md project conventions:** Conventional Commits без Co-Authored-By, scope = соответствующий extractor / mapper / pipeline.
- **Test framework:** vitest. Запуск: `pnpm test`. Type-check: `npx tsc --noEmit`. Lint: `pnpm lint`.
- **Не трогать** `graphify-out/`, `arch-graph-out/`, `/tmp/*` в коммитах. selective `git add` обязателен.
- **Anonymization rule (per memory `feedback_eval_rerun_releaks_anonymization.md`):** прогоны на реальных проектах (project-a/b/c — реальные monorepo) re-dump'ят имена. Сценарий — после прогона прогнать те же шаги scrub'а, что и в коммите `cc149fe` (см. memory `project_en_strict_rescore_blocked_on_history.md`). Перед коммитом любых eval-results файлов проверять, что нет утечек.
- **Ground-truth pattern:** BullMQ-extractor использует ground-truth regex corpus для валидации recall. Cron-extractor должен следовать тому же паттерну — `--strict` mode должен ловить регрессии recall.
- **Schema version impact:** новый NodeKind `cron-schedule` появляется в графе. Существующие `arch-graph-out/*/graph.json` НЕ требуют пересборки автоматически (граф эволюционирует), но пересборка автоматически подхватит. Semantic schemaVersion НЕ меняется (текущая v2 уже использует contentHash). При наличии cron-нод они будут добавлены в semantic индекс инкрементально.

## Open questions

- **Q1 (Task 2):** скрипты скоринга graphify-стороны — есть ли в репо или надо написать? **Решение:** Haiku-agent в Phase 2.5 перед Wave 2 находит готовые скрипты или пишет минимальный node CLI.
- **Q2 (Task 3c):** включать ли `--types` флаг по умолчанию? **Решение:** не по умолчанию (perf risk на больших проектах). Отдельная опция `--with-types`. По умолчанию — skip.
- **Q3 (Task 3a):** human-readable cron expressions — добавлять ли cronstrue dep? **Решение:** нет, inline mapping только для well-known `CronExpression.X` aliases (~10 значений). Кастомные expressions хранятся as-is.
- **Q4 (Task 2 — graphify revalidation):** пересобирать ли graphify-out на проектах перед прогоном? Memo от 2026-05-17 указывал на чувствительность strict-score к graphify graph mutation. **Решение:** пересобирать (`graphify build` per project), фиксировать дату в memo. Иначе сравнение будет не fresh.

## Acceptance Criteria

### Task 1 — UI alignment

- [ ] **AC1.1:** В секции bench-cards head-to-head (lines 402-425) все 4 карточки имеют одинаковую высоту заголовка → ряды `.bench-card-row` и `.bench-card-foot` визуально выровнены при ширине 1200px+. Verify: Playwright + screenshot.
- [ ] **AC1.2:** В остальных bench-card секциях (semantic layer at 358-381) ничего визуально не сломалось — карточки выглядят как до правки. Verify: Playwright.
- [ ] **AC1.3:** Строка `multilingual-e5-base` (line 367) не переносится, прижата к правому краю card-row. Verify: Playwright + computed style check (`getBoundingClientRect()`).
- [ ] **AC1.4:** HTML валиден (никаких новых broken tags). Verify: parse-check `tidy` или просто проверка, что DOM рендерится без ошибок в консоли.

### Task 2 — Head-to-head re-run

- [ ] **AC2.1:** Полный прогон `scripts/run-baseline-eval.sh` с `MODEL=e5-base EVAL_MODE=both-buckets QUERIES_FILE=scripts/eval/queries.json` — артефакт `scripts/eval/results-2026-05-19-both-buckets-e5-base.md` существует, числа консистентны с предыдущим e5-base baseline (75% overall ± 1pp по шуму).
- [ ] **AC2.2:** Аналогично — `queries-en.json` прогон.
- [ ] **AC2.3:** graphify-side прогон — `/tmp/graphify-eval-responses-2026-05-19.jsonl` + `/tmp/graphify-en-responses-2026-05-19.jsonl` существуют, содержат stdout per query.
- [ ] **AC2.4:** Memo `docs/comparisons/2026-05-19-arch-graph-vs-graphify-eval.md` создан, структура повторяет 2026-05-17, включая TL;DR + RU + EN strict re-score + caveats. Все числа — фактические из текущего прогона.
- [ ] **AC2.5:** `docs/index.html` обновлён — числа в head-to-head card (lines 379-380) отражают результаты re-run. Текст в card foot (line 381) обновлён с новой ссылкой на memo от 2026-05-19.
- [ ] **AC2.6:** `docs/BENCHMARKS.md` — добавлена секция «2026-05-19: e5-base vs fresh-graphify» с таблицей по 3 проектам, RU + EN strict.
- [ ] **AC2.7:** Никаких утечек реальных имён в коммите (scrub проверен). Verify: grep по platform_*, insyra_*, beribuy.

### Task 3a — Cron extractor

- [ ] **AC3a.1:** Новые файлы созданы: extractor, scheduler-registry-index, constants, mapper, validator. Wired в `src/pipeline/build.ts`.
- [ ] **AC3a.2:** NodeKind `'cron-schedule'` добавлен в union в `src/core/types.ts`. EdgeKind `'cron-triggers'` добавлен. Exhaustiveness gate пройден (компилируется).
- [ ] **AC3a.3:** Unit-тесты для Cron-extractor, покрывающие happy path + edge для всех 4 decorator-форм (@Cron string, @Cron CronExpression, @Interval, @Timeout) + dynamic registration через SchedulerRegistry. Минимум 8 тестов. Все проходят.
- [ ] **AC3a.4:** Ground-truth validator работает — `arch-graph build --strict` на fixture с known @Cron sites не валит ошибку на 100% recall.
- [ ] **AC3a.5:** Semantic embed-text для cron-schedule node включает `kind + label + expression + humanReadable`. Verify: spot-check на test fixture, проверить, что node попадает в semantic index.
- [ ] **AC3a.6:** Self-build (`pnpm build:semantic`) на arch-graph repo не падает; cron-schedule nodes присутствуют, если в коде есть @Cron (если нет — пустой набор без ошибок).
- [ ] **AC3a.7:** Quality gates: `pnpm test` все проходят, `npx tsc --noEmit` 0 ошибок, `pnpm lint` 0 ошибок.

### Task 3b — BullMQ Phase 1 extras

- [ ] **AC3b.1:** Queue node meta содержит `concurrency`, `defaultDelay`, `defaultAttempts`, `defaultBackoff`, `hasRepeat` (`undefined` если не указано).
- [ ] **AC3b.2:** EdgeKinds `'queue-fails-into'` и `'queue-event-listener'` добавлены в union. Exhaustiveness gate пройден.
- [ ] **AC3b.3:** Unit-тесты — 6-8 spec'ов на новую функциональность. Все проходят.
- [ ] **AC3b.4:** Quality gates passing.

### Task 3c — BullMQ Phase 2 + cross-enrichment

- [ ] **AC3c.1:** `--with-types` флаг (или эквивалент) включает job-data extraction. Тип параметра `Job<DataType>` резолвится для @Process методов.
- [ ] **AC3c.2:** Worker scaling — если worker создан фабрикой с env-fallback, default value резолвится в meta.
- [ ] **AC3c.3:** Cross-enrichment: `queue.add(..., { repeat: { cron: '...' } })` создаёт cron-schedule node + edge `queue-repeat` (queue → cron-schedule).
- [ ] **AC3c.4:** Unit-тесты — 4-5 spec'ов. Все проходят.
- [ ] **AC3c.5:** Quality gates passing.
- [ ] **AC3c.6:** Performance: `--with-types` не замедляет build больше чем ×2 на test corpus (фиксируем baseline на self-build).
