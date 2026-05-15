# arch-graph — открытые вопросы и решения

Каждый delegated блок записывает сюда:
- **Blockers** — что заблокировало доведение блока до 0 findings (нужно решение пользователя)
- **Decisions** — решения, которые агент принял сам (для ревью пользователем)
- **Deferred** — что осознанно отложено за рамки блока

Структура: одна секция на блок. Краткие записи. Без воды.

---

## Block A — NestJS DI extractor

**Status**: landed. 5/5 проектов green (recallModules 100%, recallImports/Providers/Exports/Controllers 100%, resolveRate 98.7-100%).

**Decisions (агент сам принял)**:

1. **`di-controller` edge — оставлен в первой версии** (не отложен). Спец говорит "optional, nice-to-have" — но семантика очень дешёвая, и controllers в графе очевидно полезны для "кто слушает HTTP". Эджей мало (~25-110 на проект), отдельный `EdgeKind` оправдан.

2. **`useExisting → providerKind: 'existing'`** (отдельный kind, не `class`). Хоть архитектурно `useExisting` всегда указывает на класс, разница важна для visualization: `useExisting` — это alias-injection, не declaration. Сохраняем nuance в `meta.providerKind`.

3. **`forRoot()` / `forRootAsync()` / `registerQueue()` etc. — все treat as `dynamic` ref kind**, callee root identifier = module class. Args не парсятся (`useFactory: () => ({...})` — body не нужен для архитектуры).

4. **Field-presence ground truth (не entry-count)**. Из 4 возможных GT-уровней (modules, fields, entries, resolve) выбраны 3: modules + fields + resolveRate. Подсчёт array-entries отдельной regex — невозможен без AST из-за multiline, comments, spreads. Это путь к hidden recall regressions; GT нарочно ограничен тем, что regex может надёжно посчитать.

5. **Brace-balanced scan для field-GT — не plain regex**. `BullModule.registerQueueAsync({ imports: [ConfigModule], ... })` инсайд `@Module({...})` имеет nested `imports:` — не наша архитектура. Скан только depth-1 ключей объекта-аргумента `@Module`.

6. **`hasXField` boolean флаги выкинуты** — `fieldLocations.X !== null` — тот же сигнал, без дублирования state.

7. **`flags.hasDynamic<Field>` теперь flip-ит на ЛЮБОЙ unresolved** (spread, conditional, non-array-init, object-no-spread). Раньше — только spread.

**Self-review (pr-review-toolkit недоступен — Task tool не загружен)**: 7 findings найдены и применены (consistent dynamic flags, dead `hasXField` flags removed, `PropertyAccess` без `snippet` truncation, dead `declaringSite` parameter, jsdoc fix для `resolveRate`, и т.п.). Critical/important: zero remaining.

**Deferred**:

- **Shorthand property `@Module({ imports })`** (без `:`) — в 5 проектах не встретилось. Если встретится, extractor пропустит поле, GT validator его посчитает → recall regression. Фикс: разрешить `ShorthandPropertyAssignment` в `findProp` (имя поля = identifier text). Шаблон редкий, gated by recall.

- **Per-ref source loc в diagnostics**. Сейчас `unresolvedRefs[].location` — `@Module` decorator line. Если будут жалобы на UX диагностики — добавить per-element location в `DiModuleRef` / `DiProviderRef`.

- **Provider-array object-spread fallback** (analog `imports`-array spread): `providers: [{ ...sharedProviders }]`. В 5 проектах не встретилось.

- **Cross-package module collisions**. Если две библиотеки имеют `FooModule` — index хранит последний found. Граф схлопывает их в один `module:FooModule` node. Это не bug (имена одинаковые → один логический модуль), но если разные FooModule имеют разные `providers`, edges merge корректно за счёт key=`kind:from->to`. OK для now.

**Metrics (5 проектов)**:

| Project | Modules | Imports | Providers | Exports | Controllers | resolveRate | Graph (DI edges) |
|---|---|---|---|---|---|---|---|
| platform | 123 | 291 | 385 | 173 | 110 | 99.6% | 905 |
| insyra | 56 | 196 | 192 | 115 | 78 | 99.5% | 560 |
| beribuy2 | 8 | 25 | 58 | 6 | 27 | 100.0% | 113 |
| unpacks | 31 | 95 | 67 | 45 | 24 | 100.0% | 228 |
| screenia | 53 | 166 | 119 | 60 | 46 | 98.7% | 373 |

---

## Block B — HTTP inter-service extractor

**Landed.** Inter-service HTTP extractor with URL resolution + internal/external
classification. 5/5 projects: recall 100% against ground truth (grep
`httpService.<method>` + `axios.<method>` + `axios(` + `fetch(`).

5-project metric table (sites = extracted, GT = ground-truth, internal/external = edges):

| Project   | sites | GT | recall | http-call (internal) | http-external | resolveRate |
|-----------|-------|----|--------|----------------------|---------------|-------------|
| beribuy2  | 9     | 9  | 100%   | 0 (domain off)       | 1             | n/a         |
| unpacks   | 2     | 2  | 100%   | 0                    | 0             | 0%          |
| screenia  | 14    | 14 | 100%   | 0                    | 1             | 0%          |
| insyra    | 15    | 15 | 100%   | 0                    | 1             | 0%          |
| platform  | 51    | 51 | 100%   | 4 (deployer×2, etc.) | 3             | 7.8%        |

The resolve metric reads low across the board because most real HTTP traffic in
this corpus is external (Telegram/Stripe/PayPal/TBank/Timeweb APIs) — by the spec's
strict reading, those don't count toward "resolved". That's the intended trap-avoid:
NATS hit a similar inflate where pattern-with-runtime-args got coded as resolved.

**Decisions taken**:

- **Resolve-metric reading (strict, per spec hint in brief)** — `resolveRate` counts
  only (a) `literal` URL matching `internalServices[*].urlPatterns`, and (b) `env-ref`
  matching `internalServices[*].envVars`. Literal-external (`https://api.stripe.com/...`)
  is NOT resolved, by design — the metric measures *internal-graph-edge yield*, not
  *URL-resolution success*. Recall is the gate; resolve is informational.

- **`env-ref` carries `pathSuffix`** — `\`${this.baseUrl}/users/${id}\`` where
  `baseUrl = configService.get('X_URL')` upgrades the whole template to an `env-ref`
  with `pathSuffix='/users/*'`. Without this, the dominant internal-call shape would
  always degrade to `pattern` and miss the internal classification entirely.

- **`??` / `||` fallback unwrap** — `this.configService.get('X_URL') ?? ''` and
  `process.env['X'] || '/api/v1'` are unwrapped to the LHS first (env-ref / config),
  falling back to RHS literal if LHS unresolved. Discovered when screenia's
  frontend hooks were all degrading to `pattern`.

- **`<TResponse>` type-args in GT regex** — `httpService.post<TResponse>(...)` is
  the NestJS norm. GT regex allows an optional `<...>` between method name and `(`.

- **env-ref to a service not declared in `internalServices` → diagnostics, not edge** —
  We have no hostname to attribute it to (env-vars hide the actual host). Emitting an
  `external:<env-var>` node would clutter the graph with placeholder nodes operators
  can't reason about. The site stays in `diagnostics.unresolved`; the operator can
  fix the config to attribute it.

- **HttpService receiver matched by tail property `httpService`** — case-sensitive.
  This is the @nestjs/axios convention (always exposed under that exact name);
  matching `endsWith('httpService')` on the property access covers `this.httpService`
  and any subclass / DI-replaced injection without forcing type-resolution.

**Deferred (not in v1)**:

- **Wrapper-client auto-discovery** — `this.platformApiClient.fetchUser(id)` where
  `platformApiClient` is a typed class wrapping `HttpService`. NATS solved this with
  Pattern F (wrapperPublishApis + auto-discovery). For HTTP it would require
  per-class method-name configuration (e.g. `[{ class: 'PlatformApiClient',
  methods: ['fetchUser', ...], urlAttribute: 'service:platform-api' }]`) — different
  enough from NATS to warrant a separate Phase 2 pass. Cost in v1: any indirect HTTP
  through a typed client is invisible to the graph.

- **`axios.create({ baseURL }).get(path)` cross-statement tracking** — would require
  tracking the variable from `const client = axios.create({...})` to its `.get()`
  call sites. Emits `unresolved` today. Pattern is rare in the corpus (saw 1 site).

- **`process.env['X_URL']` literal-style env access** — currently NOT detected as
  env-ref (we only detect `configService.get('X')`). Adding it is straightforward
  if more pure-node services land; today the corpus is NestJS-heavy where
  `ConfigService` is the convention. Marker for revisit.

- **GraphQL / tRPC / gRPC** — separate domains. Not in this block.

- **Wrapper services using non-`httpService` names** — e.g. `this.myHttpClient.get()`
  where `myHttpClient: HttpService`. We match by property tail name (`httpService`),
  not by injected type — would require type resolution. Skipped same reason as
  wrapper-client auto-discovery.

**Open question for review**:

- **`external:<host>` deduplication** — sites pointing to `api.telegram.org` from
  3 different libs collapse to one `external:` node + 3 edges (good). But sites
  like `localhost` (when literal URL contains `http://localhost:3000`) all
  collapse to one `external:localhost` node — that's hostname-correct but the
  user may want it bucketed differently. Current behaviour: one node per hostname,
  no port. Revisit if user feedback says hostname dedup is too coarse.

---

## Block C — TS-import extractor (dependency-cruiser)

**DECISION: ts-morph вместо dependency-cruiser.**

Спека ссылалась на `dependency-cruiser`, но в проекте уже подключён `ts-morph` и `runBuild` загружает единый `Project` для всех extractor'ов. Добавлять dependency-cruiser значило бы:
- лишнюю dep + второй проход AST (cruise() запускает свой scanner внутри);
- два разных source-set'а (его exclude/ignore не совпадают с нашими `excludeGlobs`);
- расходящуюся ground-truth (наш regex считает `^import` по нашему фильтру файлов; cruiser шёл бы по своему).

Trade-off: разрешение path-aliases у ts-morph слабее (когда `Project` создан без tsconfig). Решено вручную: парсим `<root>/tsconfig.base.json` или `<root>/tsconfig.json` и резолвим алиасы через `compilerOptions.paths`. Покрывает 95% Nx/Nest монорепо.

**Metrics (build на 5 проектах, recall = extracted/GT static imports):**
- screenia:  100.0% recall (2978/2860 — ts-morph иногда находит больше, чем regex видит); 24 lib-usage edges
- platform:  100.0% recall (7340/7093); 209 lib-usage edges, 2 antipattern (service→service)
- insyra:    100.0% recall (5284/4981); 24 lib-usage edges
- unpacks:   100.0% recall (1728/1648); 7 lib-usage edges
- beribuy2:  100.0% recall (2288/2179); 10 lib-usage edges

(recall capped at 1.0 — extracted > GT возникает когда regex пропускает multi-line imports: `IMPORT_RE` шаблон `[^;\n]*?` не пересекает newline, поэтому многострочный `import {\n  A,\n  B\n} from '...'` для regex невидим, а ts-morph видит его как одну ImportDeclaration)

**Что не делается:**
- `require('./foo')` (CommonJS) — out of scope блока. В монорепо `apps/`+`libs/` это редкая форма (только runtime-конфиги или legacy). Если понадобится — добавить отдельный walk для `CallExpression` к идентификатору `require`.
- Resolution через `compilerOptions.extends` цепочки (composite tsconfigs с `references`) — мы загружаем только корневой `tsconfig.base.json`/`tsconfig.json`. Если алиасы переопределены в app-tsconfig — не подцепится. Признак: значимый `unresolvedInternal` count.
- Side-effect-only imports (`import './polyfill'`) — извлекаются, но `externalOrUnresolved` heuristic считает их external если specifier не относительный (для bare specifiers это правильно).

**Gate:** recall ≥ 80% (мягче чем NATS/TypeORM/BullMQ 95% — alias-resolution это best-effort). Фактически все 5 проектов выдали 100%.

**Default config:** `imports.fileLevel = false`. File-level `ts-import` edges (file→file) генерятся только при явном opt-in — иначе граф захлёбывается (Platform: 7340 imports → ~7340 рёбер только в этом домене).

**Self-review (вместо pr-review-toolkit — субагенты в этом контексте недоступны):**
Сам отревьюил по 5 lens'ам:
- **silent-failure-hunter**: `loadTsConfigPaths` глотал JSON parse errors — добавил `process.stderr.write` warning. `isAliasPrefix` имел false-prefix bug (`@platform` бы матчил `@platform-other`) — исправлено: храним alias prefixes с trailing `/`. Trailing-comma support в JSONC добавлен (Nx часто их использует).
- **type-design**: `TsImportSite.specifierShape` discriminated на 4 значения (relative/alias/bare-external/builtin) — mapper использует это вместо хрупкой heuristic. Раньше `isExternalShape` в mapper'е помечал любой non-relative как external и маскировал alias-resolver regressions.
- **code-simplifier**: `aliasResolverBundle` объединяет два API в один объект; pre-compute prefix list once вместо `.map()` в hot loop.
- **comment-analyzer**: каждая нестандартная heuristic ("why first-seen file wins", "trailing slash matters") задокументирована в коде.
- **code-reviewer**: GT regex теперь видит multi-line imports (`[\s\S]*?` вместо `[^;\n]*?`); side-effect form (`import './x'`) разделена отдельной regex с negative-lookahead для не-двойного матча.

---

## Block D — Mermaid output

### Decisions

**Node shapes** (per NodeKind):
- `service` → `id["label"]` (rectangle, primary entity)
- `lib` → `id["label"]` + class `lib` (same rectangle; differentiated by classDef fill)
- `queue` → `id(["label"])` (stadium — async boundary)
- `nats-subject` → `id(("label"))` (circle — pub/sub endpoint)
- `db-table` → `id[("label")]` (cylinder — storage)
- `module` → `id{{"label"}}` (hexagon — DI module)
- `file` → `id["label"]` + class `file`

**Edge syntax** (per EdgeKind):
- sync RPC (`http-call`, `nats-request`, `nats-reply`) → thick arrow `==>|label|`
- async fire-and-forget (`nats-publish`/`subscribe`, `queue-produce`/`consume`, `ts-import`, `lib-usage`, `di-*`) → dotted arrow `-.->|label|`
- DB access (`db-read`/`write`/`access`) → open arrowhead `--o|label|`

**Note on DI dotted arrow**: первоначально использовал `-..->` (more dots) для зрительного де-приоритета, но эта форма ломается в части Mermaid версий — все de-emphasised kinds сейчас используют общий `-.->` + edge-label (`di`, `import`, `lib`) как смысловой различитель.

### Layout

- `flowchart LR` (вертикальный LR — ширина выше высоты, лучше для multi-service графа)
- Один subgraph на NodeKind (`Services`, `Libraries`, `Modules`, `Queues`, `NATS subjects`, `DB tables`, `Files`)
- Ноды внутри subgraph отсортированы по label, edges отсортированы по `(kind, from, to)` — стабильные diff'ы
- `classDef` + bulk `class id1,id2 cls;` — стили в конце файла, не inline (читаемость, дифабельность)

### Truncation policy

- Header comment `%% graph has N nodes, M edges — consider per-service slicing` when `N > 200`
- Полный граф всё равно пишется (Mermaid Live рендерит ~500 нод, наш максимум сейчас — insyra 579 нод; рендерится медленно, но валидно)
- Опциональное slicing'ование через `--mermaid-slice=`:
  - `per-service` → `<out>/mermaid/service-<id>.mermaid` (skip services с 0 рёбрами)
  - `domain:<key>` → `<out>/<key>.mermaid` (keys: `nats`, `bullmq`, `typeorm`, `http`, `di`, `ts-import`, `lib`)

### Validation

Counts (nodes/edges) в `graph.mermaid` совпадают с `graph.json` на всех 5 проектах:

| project   | nodes | edges | bytes  |
|-----------|-------|-------|--------|
| beribuy2  |    45 |    66 |  8 099 |
| screenia  |   139 |   154 | 24 838 |
| platform  |   315 |   408 | 59 894 |
| insyra    |   579 |   638 | 110 765|
| unpacks   |   110 |   117 | 17 840 |

Структурная валидация: все subgraph balanced (`open === close`), все edge endpoints определены среди node decls (0 missing).

### Deferred

- **Per-service для frontend сервисов**: platform/screenia/unpacks имеют фронт-сервисы без extractor coverage (NATS-only бэк, no DI/HTTP yet) → 0 рёбер → файл не создаётся. Корректно для текущего набора extractor'ов; пересмотреть после Block B (HTTP) и Block A (DI).
- **Mermaid parser validation**: пакет `mermaid` отсутствует в `node_modules` (peer-only зависимость), валидация ограничена structural pass'ом. Live rendering проверяется в Mermaid Live Editor / `mmdc` CLI вне scope этого блока.
- **`ts-import` domain visualisation**: ноды `module`/`file` пока не emit'ятся ни одним extractor'ом (нет DI/TS-import) — соответствующие subgraph'ы будут пустыми; рендерятся корректно (просто не появляются).

---

## Block E — BullMQ pr-review findings (Phase 2 followup)

Все 5 pr-review-toolkit агентов (sonnet) отработали. Применено:

**Cross-cutting dedup (simplifier)**:
- `buildLineStarts` / `offsetToLineCol` / `indexBy` → [`src/validation/line-index.ts`](src/validation/line-index.ts)
- `ownerNodeId` / `ownerNodeFor` → [`src/mapper/owner-node.ts`](src/mapper/owner-node.ts)
- `isExcludedSourceFile` → [`src/extractors/shared.ts`](src/extractors/shared.ts)
- `collectRegistrations` — 4 одинаковых push-ветки схлопнуты в `resolveRegistrationArg`
- `getLiteralText` каст приведён к `StringLiteral` (как в NATS)

**Type-design (4/5 baseline + улучшения)**:
- `BullMqQueueRegistration.role = 'registration'` добавлен → uniform discriminant
- `BullMqValidationReport.extraConsumers` / `extraRegistrations` добавлены (symmetric с TypeORM)
- `BullMqSite` type alias добавлен
- Doc-комментарий `BullMqQueueRef` уточнён (NOT mirror of `TypeOrmEntity.tableSource`)
- `resolveRate` zero-fallback явно задокументирован

**Critical / High findings (code-reviewer + silent-failure-hunter)**:
- **CRITICAL**: `@Processor({ name: 'q', concurrency: 5 })` форма — symmetric blind spot extractor+GT. Исправлено:
  - extractor `resolveQueueArg` добавлена `ObjectLiteralExpression` ветка с `findProp(obj, 'name')`
  - validator `PROCESSOR_RE` / `INJECT_RE` — добавлена альтернатива для `{ name: ... }`
- **HIGH**: anonymous `@Processor` class — раньше тихо ронился; теперь `className = '<anonymous>'` sentinel
- **HIGH**: tail-only PropertyAccess lookup мог давать **неверные** рёбра (`QueueNames.X` совпадало с unrelated `export const X`); fallback убран, теперь honest-unresolved

**Deferred**:
- **HIGH #4 (silent-failure-hunter)** — non-exported queue-name constants (`const X = 'foo'` без `export`). Сейчас попадают в `diagnostics.unresolved` без `reason` поля. Не silent failure, а diagnostic quality. Фикс — добавить `reason?: string` к `BullMqQueueRef.unresolved` + опционально same-file scope в `QueueNameIndex`. Откладываем — паттерн редкий, в 5 тестовых проектах не встретился.

**Comment-analyzer**:
- "Skipped (Phase 1)" → "Not yet handled" (Phase 2 файл некорректно ссылался на Phase 1)
- `collectRegistrations` doc — добавлено "why variadic"
- Положительные находки: header'ы pre-pass index'а и комментарии "one edge per (owner, queue, kind)" хвалят

---

## Block F — MCP server

_В работе._

---

## Block G — Install / Skill / Hooks / README

_В работе._

---

## Block H — Benchmark suite (arch-graph vs graphify)

**Status**: landed. `bench/` модуль, 15 вопросов, 5 проектов. arch-graph 100 % recall на 688K токенов (15Q), graphify 39 % recall на 5.2M токенов (7.6× больше) для двух проектов с готовым `graphify-out/`.

**Decisions (агент сам принял)**:

1. **`graphify` не запускается из `run.sh`.** graphify — это Claude skill, а не one-shot CLI: внутри он диспатчит general-purpose subagent'ов и просит ручного labeling'а сообществ. Запуск из скрипта невозможен. `run.sh` детектит наличие `<project_root>/graphify-out/graph.json` (либо `bench/cache/<project>/graphify-out/graph.json`) и пропускает leg если файла нет. README документирует: `/graphify <root>` нужно запустить из Claude-сессии вручную, после чего пере-запустить `bash bench/run.sh`.

2. **ID schemes несравнимы — ground truth выражается labels, не IDs.** arch-graph IDs: `service:platform-api`, `nats:platform.events.message.received`. graphify IDs: `apps_platform_api`, lowercase + underscore. Подстрочный поиск `service:platform-api` в graphify-контексте дал бы 0% recall by construction. Решение: `questions.yaml` хранит `ground_truth_ids` (canonical, для дебага) и `ground_truth_labels` (что реально ищем — `"platform-api"`, `"platform.events.message.received"`, `"PlatformConnectionService"`). Эвристика бьёт labels по обоим контекстам — fair comparison.

3. **Идентичная компрессия обоих графов.** Оба adapter'а сжимают до `{id, k, label?}` для нод и `{f, t, k, at?}` для эджей. Если изменить агрессивность одного — нужно зеркалить второго, иначе token-counts несравнимы. Прокомментировано в README.

4. **Heuristic = substring presence, не LLM-eval.** "Did the context even contain the answer?" — necessary-condition check. Documented в `report.md` (`Heuristic` section). Precision стабильно 100 % by construction (мы ищем только GT labels, любой match — корректный); интересная ось — recall × tokens.

5. **Token encoding = `cl100k_base`** (gpt-4 family). Самый распространённый industry-стандарт для context-token measurement.

6. **Build-time для graphify не измеряется.** graphify-build живёт минутами + жжёт LLM-токены; включить в `run.sh` = burn $$$. Документировано в README.

7. **Question category mix**: 4× NATS, 2× BullMQ, 2× TypeORM, 3× DI (incl. lib), 1× HTTP, 1× lib-usage, 2× multi-hop. Уважает `domains.bullmq=false` / `http=false` в `beribuy2.config.ts` (для beribuy2 BullMQ/HTTP вопросов нет).

**Deferred**:

- **Per-question subgraph retrieval.** Сейчас bench feed-ит весь compact graph как контекст. Реалистичнее: per-question retrieval (BFS от matched node, depth 2). Это уменьшит arch-graph tokens на порядок, но не изменит головной вывод (graphify останется крупнее + хуже recall на architectural questions). Отложено до Block I.
- **LLM-judge eval** вместо substring-heuristic. Дорого, недетерминированно, requires API key — но более fair для graphify (label может быть на graph через `conceptually_related_to` без явного substring-match). Также Block I.
- **graphify legs для insyra/beribuy2/unpacks.** Каждый — отдельная Claude-сессия с `/graphify <root>` + manual community labeling. Документировано в `report.md` `Skipped legs`.

Disclaimer-секция в report.md явно признаёт bias в сторону arch-graph (selection + ground-truth derivation). Это и было задачей — показать ценность domain-specific графа на domain-specific вопросах.

---

## Общие открытые вопросы (orchestration-level)

- _будет дополнено по ходу_
