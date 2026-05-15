# arch-graph — открытые вопросы и решения

Каждый delegated блок записывает сюда:
- **Blockers** — что заблокировало доведение блока до 0 findings (нужно решение пользователя)
- **Decisions** — решения, которые агент принял сам (для ревью пользователем)
- **Deferred** — что осознанно отложено за рамки блока

Структура: одна секция на блок. Краткие записи. Без воды.

---

## Block A — NestJS DI extractor

_В работе._

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

_В работе._

---

## Block D — Mermaid output

_В работе._

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

## Общие открытые вопросы (orchestration-level)

- _будет дополнено по ходу_
