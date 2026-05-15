# arch-graph — deferred extractor extensions

Анализ "трудных" NATS/TypeORM сайтов в 5 production-монорепо после Pattern F v2
показал 4 категории, оставленные за пределами текущей итерации. Документ
фиксирует **что мы уже автоматически находим**, **что остаётся**, и **как это
надо чинить** (без жёсткого тайминга — кандидаты в Phase 2/Phase 3).

---

## Что extractor уже автоматически находит (iter4 baseline)

### NATS
- **Pattern A** — стандартные `ClientProxy.send/emit` и `@MessagePattern`/`@EventPattern`
- **Pattern B/C** — литеральные и template-string subjects через ConstantIndex (cross-ref до глубины 16, fn-template подстановка параметров)
- **Pattern D/E** — динамические template literals → `kind: 'pattern'` с placeholder'ами (`agent.*.events`)
- **Pattern F v1** — class-method wrappers с `subject = arg[0]` метода (auto-discovery)
- **Pattern F v2** — class-method wrappers с **subjectArgIndex != 0** (например `Helper.sendWithRetry(client, subject, payload)`)
- **Pattern F v2** — **standalone exported function wrappers** (`sendNatsMessage(client, pattern, payload)` без enclosing class)
- ElementAccess / Conditional → recurse into branches before falling to `unresolved`
- Auto-detection misconfigured wrapper classes (WARNING при отсутствии класса в проекте)

### TypeORM
- `@Entity('table')` / `@Entity({ name, schema })` / `@Entity()` snake_case fallback
- Pre-pass `EntityIndex` для @InjectRepository → table resolution
- Constructor-param injection (`constructor(@InjectRepository(X) private repo)`)
- **`export { X as Y }` re-export aliases** (iter4: barrel re-exports в `libs/<scope>/entities/index.ts`)

### Cross-cutting
- Cardinality matching ground-truth ↔ extracted (multi-decorator-per-line)
- Per-role zero-GT gate (handlers/senders/injections/entities независимо)
- `cfg.excludeGlobs` симметрия project-loader ↔ validators
- Stage-labeled errors в pipeline
- Stripped-comments перед import-filter (false-positives на закомментированных импортах)

**Текущие метрики (5/5 проектов в gate):**

| Project | NATS recallH/S | NATS classify/resolve | TypeORM recallInj/Ent | TypeORM resolve |
|---|---|---|---|---|
| platform | 100/100 | 99.3 / **95.9** | 100/100 | 100 |
| insyra | 100/100 | 99.3 / **98.7** | 100/100 | 100 |
| beribuy2 | 100/100 | 100 / 94.9 | 100/100 | 100 |
| unpacks | 100/100 | 100 / **100** | 100/100 | 100 |
| screenia | 100/100 | 100 / **100** | 100/100 | **100** |

---

## Deferred: оставшиеся паттерны

Все эти паттерны нашли haiku-агенты при анализе `diagnostics.json` каждого
проекта. Сайты с такими паттернами сейчас попадают в `nats.dynamic` или
`nats.unresolved` — не блокируют gate, но идеально были бы в графе.

### D1. Object-literal-arg with field-access (Medium cost, ~6 сайтов)

**Где:** `platform-cron/src/services/cron-scheduler.service.ts` (3 сайта),
`insyra/be-cron-service/src/services/cron-scheduler.service.ts` (3 сайта).

**Пример:**
```ts
await this.natsExecutorService.executeNatsTask({
    jobName,
    pattern: job.pattern,        // <-- реальный subject здесь
    payload: { ... },
    executionId: execution.id,
});
```

Wrapper `executeNatsTask` принимает один **object-literal** аргумент с полями
`pattern`/`subject`/`topic`/`event`. Inside body — `client.publish(input.pattern, ...)`
где `input.pattern` это property-access на параметр.

**Почему текущий Pattern F не справляется:** discovery ищет subject = bare
parameter (`pattern`), а здесь subject = `input.pattern` (PropertyAccess).
`resolved.kind` для `input.pattern` будет `unresolved` (no symbol для property
on param-typed object), а не `dynamic+param`. Auto-discovery не срабатывает.

**Как фиксить:**
1. В resolver добавить case для PropertyAccess where object is параметр enclosing
   функции — пометить как "dynamic+object-prop:input.pattern".
2. В Pattern F discovery: если subject pattern matches "dynamic+object-prop:X.Y",
   зарегистрировать wrapper с `subjectField: 'Y'` (имя поля).
3. В pass 2: при вызове wrapper'а, если arg[subjectArgIndex] это
   ObjectLiteralExpression, искать в нём `PropertyAssignment` с именем
   `subjectField` и резолвить его initializer как subject.

**Ожидаемый прирост resolve:** ~6 сайтов суммарно (~+1.5pp на platform, +0.4pp на insyra).

---

### D2. Factory-generated controller with decorator-param (Medium cost, ~3 сайта)

**Где:** `platform/libs/platform/appointment-app-sdk/src/sync-bridge/create-sync-bridge-controller.ts`,
`platform/libs/platform/core/src/infra/health/nats-health-controller.factory.ts`,
аналог в insyra.

**Пример:**
```ts
export function createSyncBridgeController(natsSubject: string) {
    @Controller()
    class SyncBridgeNatsController {
        @EventPattern(natsSubject)  // closure-param, не литерал
        async onSyncCompleted(data: { ... }) { ... }
    }
    return SyncBridgeNatsController;
}
```

**Почему текущий extractor не справляется:** `@EventPattern(natsSubject)` — это
decorator с Identifier arg, который ссылается на параметр enclosing function.
Текущий resolver вернёт `dynamic+param`. Класс не зарегистрирован в
publishApis/subscribeMethodApis, поэтому decorator-handler идёт через
`STANDARD_SUBSCRIBE_DECORATORS`, и dynamic-subject не записывается в графе.

Auto-discovery class-method wrappers (Pattern F) сюда тоже не подходит, потому
что enclosing — это factory function, а ContoroleClass генерится динамически.

**Как фиксить:**
1. При резолве arg декоратора `@EventPattern`/`@MessagePattern` детектировать
   "dynamic+factory-param:natsSubject" — сохранить как pattern `kind: 'factory-param'`.
2. Зарегистрировать factory function `createSyncBridgeController` как
   "controller-factory wrapper" с `subjectArgIndex` параметра.
3. В pass 2 найти callers `createSyncBridgeController('exact.subject')` и
   эмитнуть `nats-subscribe` edge на `service` который вызвал factory.

Цена: medium — нужно отдельное состояние "factory-discovered" в `discovered[]`.

**Ожидаемый прирост:** ~3 сайта, графовая ценность высокая (нативные контроллеры
на динамических subject'ах часто пропускают).

---

### D3. JetStream `subscribe({ stream, durableName }, handler)` (High cost, ~4 сайта)

**Где:** `insyra/apps/be-insyra/src/modules/events/jetstream-events-consumer.service.ts:42`
и схожие.

**Пример:**
```ts
await this.jetStreamService.subscribe(
    {
        stream: JETSTREAM_STREAM_CONFIGS.EVENTS.name,
        durableName: JETSTREAM_EVENTS_CONSUMER,
    },
    async (subject: string, data: unknown) => {
        await this.handleMessage(subject, data);
    },
);
```

**Почему трудно:** subject **не передаётся** в `subscribe(...)`. Он приходит в
handler как параметр — определяется stream/durableName конфигурацией на
NATS-сервере. Без знания JetStream config (`filterSubject` поле в consumer-config
или server-side stream subjects) этот сайт **не recoverable из AST**.

**Как фиксить:**
1. Расширить config: явное mapping `{ stream: 'EVENTS', subjects: ['platform.events.*'] }`
   в `cfg.nats.jetstream`. Resolver проверяет `filterSubject` или конфиг — emit `pattern` edge.
2. Альтернатива: если у consumer-config есть `filterSubject` field прямо в коде
   (`subscribe({ stream, durableName, filterSubject: 'platform.events.*.x' })`),
   resolver может его прочитать.
3. Long-term: dependency-cruiser + ParseStream-from-JetStream-module-config.

**Ожидаемый прирост:** ~4 сайта на insyra (-1pp), требует config поддержки.

---

### D4. Conditional literal union (Low cost, 1 site)

**Где:** `platform/apps/platform-cron/src/services/messaging-events-reconciliation.service.ts:135`.

**Пример:**
```ts
let subject: string;
if (msg.sender_type === ESenderType.CLIENT) {
    subject = 'platform.events.message.received';
} else if (msg.sender_type === ESenderType.OPERATOR || msg.sender_type === ESenderType.AI) {
    subject = 'platform.events.message.delivered';
}
this.jetStreamService.publish(subject, payload);
```

**Почему трудно:** Identifier `subject` имеет несколько assignment'ов в
разных branches `if/else`. Текущий resolver видит declaration `let subject: string`
(без initializer) → `unresolved`.

**Как фиксить:** Backward-dataflow в текущей функции:
1. Найти все assignment'ы (`subject = ...`) в scope, ведущие к call-site.
2. Если **все** RHS — литералы/patterns → эмитнуть `kind: 'union'` с массивом
   subjects (`['platform.events.message.received', 'platform.events.message.delivered']`).
3. Mapper создаёт **два edge'а** (по одному на каждый subject), оба с
   `meta.union: true` для UI.

**Ожидаемый прирост:** 1 сайт на platform, но это паттерн который встретится
в любом NestJS-проекте — стоит делать в следующей итерации.

---

### D5. Loop-variable property access (Medium cost, 1 site)

**Где:** `insyra/apps/be-cron-service/src/services/cron-internal-jobs.service.ts:291`.

**Пример:**
```ts
const services = SERVICE_HEALTH_CONFIGS.filter((s) => s.name !== 'be-cron-service');
for (const service of services) {
    const response = await firstValueFrom(
        this.natsClient.send(service.pattern, { check: true })
    );
}
```

**Почему трудно:** `service.pattern` — это PropertyAccess на loop variable
`service` который is element of `SERVICE_HEALTH_CONFIGS` (известный const).

**Как фиксить:**
1. ConstantIndex расширить: для exported const arrays сохранять элементы
   как `<ConstName>[i].<field>` (или union всех значений `<field>`).
2. Resolver: если PropertyAccess.object is for-of loop variable, проверить
   iterable expression. Если iterable резолвится к known const array,
   эмитнуть `kind: 'union'` со всеми значениями.

**Ожидаемый прирост:** 1 сайт, паттерн редкий (health-check / dispatcher loops).

---

### D6. Сознательно НЕ recoverable

| Pattern | Реальный пример | Причина |
|---|---|---|
| Config-driven subject | `this.client.publish(cfg.get('SUBJECT_X'), ...)` | env-driven, не AST |
| Injected token | `@Inject('TOKEN') client` где TOKEN определён в module | DI runtime registry |
| Computed at runtime | `this.client.publish(map[key], ...)` где `map`/`key` динамические | Принципиально dynamic |

Это попадает в `diagnostics.unresolved` как honest "unrecoverable" — не баг.

---

## Roadmap расширений (по убыванию ROI)

| Задача | Сайтов | Cost | Прирост (avg) |
|---|---|---|---|
| **D1** — object-literal-arg field access | ~6 | Medium | +0.5-1.5pp |
| **D4** — conditional literal union | 1 (+ all NestJS-codebases) | Low | +0.1-0.3pp везде |
| **D2** — factory-generated controllers | ~3 | Medium | +0.3pp + graph richness |
| **D5** — loop-variable property | 1 | Medium | +0.1pp |
| **D3** — JetStream config-driven | ~4 | High | -1pp на JetStream-heavy |

**Reасонable Phase 2 batch:** D1 + D4 (полтора дня, покрывает 7 сайтов и улучшает 
читаемость codebase'ов которые активно используют object-param wrappers).

---

## Конкретные next-steps для каждого паттерна

См. секции выше: каждая содержит "Как фиксить" с конкретными правками в
resolver / discovery / mapper. Все правки изоморфны существующему Pattern F v2
дизайну (PassMode discovery + augmented APIs + suppression).
