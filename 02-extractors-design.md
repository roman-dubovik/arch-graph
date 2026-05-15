# arch-graph — детальный дизайн extractor'ов

Документ описывает реализацию каждого extractor'а с примерами из реального кода `insyra/` и `platform/`. Это спецификация: после её одобрения можно начинать код.

---

## Общая архитектура

### Service discovery

Монорепо имеет структуру `apps/<service-name>/...`. Это main unit для графа.

```typescript
interface ServiceManifest {
  id: string;          // "be-ai"
  rootDir: string;     // absolute path to apps/be-ai
  entryFile: string;   // apps/be-ai/src/main.ts
  packageJson: object; // parsed package.json (если есть)
  tsconfigPath: string;
}
```

**Алгоритм**:
1. Ищем `apps/*/tsconfig.json` или `apps/*/src/main.ts`
2. Каждый найденный сервис → `Node{kind:"service", id:"service:<dir>"}`
3. Кладём в `ServiceRegistry` — используется всеми extractor'ами

### ts-morph project setup

Каждый сервис получает свой `Project` (или один общий — решим в коде):
```typescript
const project = new Project({
  tsConfigFilePath: service.tsconfigPath,
  skipAddingFilesFromTsConfig: false,
});
```

### Контракт extractor'а

```typescript
interface IExtractor {
  name: string;
  extract(ctx: ExtractContext): Promise<ExtractResult>;
}

interface ExtractContext {
  services: ServiceRegistry;
  project: Project;
  service: ServiceManifest;  // текущий сервис
  config: ArchGraphConfig;
}

interface ExtractResult {
  nodes: Node[];
  edges: Edge[];
  unresolved: UnresolvedRef[];  // diagnostics для динамических случаев
}
```

Все extractor'ы запускаются на каждом сервисе. Merger потом схлопывает дубли узлов (одинаковый subject из разных сервисов → один node).

---

## 1. NATS extractor — основной и самый сложный

### Реальные паттерны в твоём коде

#### Pattern A — standard NestJS @MessagePattern

```typescript
// apps/be-ai/src/modules/admin-auth/admin-auth.controller.ts
import { MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class AdminAuthController {
    @MessagePattern('admin.auth.login')
    async login(@Payload() data: LoginDto) { ... }
}
```

#### Pattern B — @MessagePattern с константой

```typescript
// platform/libs/platform/core/src/features/feature-cache.listener.ts
@MessagePattern(CUSTOM_DOMAIN_NATS_SUBJECTS.RESOLVE)
async resolve(...) { ... }
```

#### Pattern C — ClientProxy.emit/send с константой объекта

```typescript
// platform/libs/platform/app-sdk/src/services/platform-features.service.ts
const result = await this.connection.request(APP_NATS_SUBJECTS.APP_FEATURES.CHECK, { feature });
```

Здесь `this.connection.request` — это wrapper над NATS, не сам `ClientProxy`. Это критично: **нужна конфигурируемая таблица "методов-публикаторов"**, не только `ClientProxy.send/emit`.

#### Pattern D — динамический subject через функцию

```typescript
const subject = APP_NATS_SUBJECTS.CALLBACKS.HANDLE(appId);
// definition:
CALLBACKS: {
    HANDLE: (appId: string) => `app.${appId}.callback.handle` as const,
}
```

Резолвится в pattern: `app.*.callback.handle`.

#### Pattern E — динамический template literal на месте

```typescript
const subject = `agent.${agentId}.messages.inbound`;
this.natsClient.emit(subject, data);
```

Резолвится в pattern: `agent.*.messages.inbound`.

#### Pattern F — wrapper-функция через приватный метод

```typescript
// insyra/apps/be-ai/.../events.service.ts:90
private fallbackNatsEmit(subject: string, data: ISSEEvent): void {
    this.natsClient.emit(subject, data);  // ← subject пришёл извне
}
```

Параметр уходит наружу. Помечаем как `indirect` — пытаемся проследить call sites метода и резолвить subject там.

---

### Конфигурация publish/subscribe API

```typescript
// arch-graph.config.ts
export default {
  nats: {
    publishApis: [
      // NestJS standard
      { type: 'ClientProxy', methods: ['send', 'emit'] },
      // Custom wrappers (нужно перечислить руками)
      { type: 'PlatformConnectionService', methods: ['request', 'publish'] },
      { type: 'JetStreamService', methods: ['publish'] },
      { type: 'NatsService', methods: ['publish', 'request', 'subscribeWithReply'] },
    ],
    subscribeApis: [
      { type: 'decorator', names: ['MessagePattern', 'EventPattern'] },
      { type: 'method', className: 'PlatformConnectionService', methods: ['handleRequest', 'subscribe'] },
      { type: 'method', className: 'JetStreamService', methods: ['subscribe'] },
    ],
  },
};
```

**Bootstrap**: первый запуск делает auto-discovery — ищет все методы, чьё имя содержит `publish|emit|send|subscribe|handle` в классах с `nats` в названии файла/класса, и предлагает добавить в конфиг.

---

### Алгоритм extractor'а

```
1. Для каждого .ts файла сервиса:
   1.1 Найти все CallExpression вида X.method(arg0, ...) где (X.type, method) ∈ publishApis
       → захватить arg0 как "subject expression"
       → захватить enclosing class/file как "sender service"
   1.2 Найти все MethodDeclaration с декоратором ∈ subscribeApis (decorator-type)
       → захватить аргумент декоратора как "subject expression"
       → захватить enclosing class/file как "receiver service"
   1.3 Найти все CallExpression к method-type subscribeApis
       → захватить первый аргумент как "subject expression"

2. Для каждого "subject expression" — резолвить (см. ниже)

3. Сгенерировать nodes и edges:
   - nats-subject node для каждого уникального резолва
   - sender service → nats-subject (kind="nats-publish" | "nats-request")
   - nats-subject → receiver service (kind="nats-subscribe" | "nats-reply")
```

### Subject resolver

Это сердце extractor'а. Вход — `Node` из AST (ts-morph), выход — `ResolvedSubject`:

```typescript
type ResolvedSubject =
  | { kind: 'literal'; value: string; confidence: 'high' }
  | { kind: 'pattern'; pattern: string; confidence: 'high' }     // app.*.events
  | { kind: 'dynamic'; hint?: string; confidence: 'low' }
  | { kind: 'unresolved'; raw: string; reason: string };
```

**Алгоритм резолва** (decision tree):

```
case StringLiteral:                    → { kind: 'literal', value: node.text }

case TemplateExpression `a.${x}.b`:    → { kind: 'pattern', pattern: 'a.*.b' }

case PropertyAccess A.B.C:
  1. Resolve A.B.C через TypeChecker.getSymbol() → variable declaration
  2. Если value — StringLiteral → return literal
  3. Если value — ArrowFunction `(...) => template`:
     → подставить параметры как '*' в template
     → return pattern
  4. Если value — Identifier (alias) → recurse

case CallExpression X(args):
  1. Resolve X → function declaration
  2. Если тело function — return template_literal:
     → подставить args (если literal) или '*' (если variable) в template
     → return pattern
  3. Иначе → unresolved

case Identifier:
  → resolve через TypeChecker → recurse на initializer

default → { kind: 'unresolved', reason: 'unsupported AST node' }
```

**Глубина рекурсии**: max 5 уровней (защита от циклов).

### Sender service identification

Sender — это не файл, а **сервис** (app), в котором найден publish. Алгоритм:

```
1. Получить filePath файла где найден publish
2. Найти ближайший ancestor dir, совпадающий с одним из service.rootDir
3. service.id → sender node
```

Файлы в `libs/` — не сервис сами по себе. Если publish найден в `libs/X` — это shared code, edge привязывается к **каждому сервису, который импортирует** этот `libs/X` файл (через dependency-cruiser данные о реверсивных импортах).

### Indirect resolver (Pattern F)

Если первый параметр публиш-метода — `Identifier` или `Parameter`, который пришёл извне (из аргумента метода-обёртки):

```
1. Найти, что это параметр enclosing MethodDeclaration → mark this method as "indirect publisher"
2. Найти все call sites этого метода
3. На каждой call site применить subject resolver к соответствующему argument
4. Result = union resolved subjects от всех call sites
```

**Граница**: max 2 уровня indirect (одна обёртка). Глубже → unresolved.

---

## 2. dependency-cruiser extractor — TS import-graph

### Реализация

Запускаем dependency-cruiser программно:

```typescript
import { cruise } from 'dependency-cruiser';

const result = await cruise(
  [service.rootDir],
  {
    tsConfig: { fileName: service.tsconfigPath },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$|\\.test\\.ts$|/dist/' },
  }
);
```

### Конвертация в наш формат

```
result.modules.forEach(mod => {
  mod.dependencies.forEach(dep => {
    edges.push({
      kind: 'ts-import',
      from: fileNodeId(mod.source),
      to: fileNodeId(dep.resolved),
      meta: { dynamic: dep.dynamic },
    });
  });
});
```

### Слой service-level imports

Для high-level графа агрегируем file-level imports в service-level: если `apps/A/X.ts` импортирует `libs/Y/Z.ts`, и `libs/Y/Z.ts` импортируется ещё из `apps/B/W.ts` — это **не** значит, что A зависит от B. Service-level imports = только прямые `apps/A/* → apps/B/*` (что вообще-то антипаттерн в монорепо, обычно через `libs/`).

Более полезная агрегация — **library usage**: `service:be-ai —uses→ lib:@insyra/nest-shared`.

### Output

```typescript
edges.push({
  kind: 'ts-import',          // file-level
  from: 'file:apps/be-ai/src/foo.ts',
  to: 'file:libs/common/src/bar.ts',
});

// + агрегированный layer
edges.push({
  kind: 'lib-usage',           // service-level
  from: 'service:be-ai',
  to: 'lib:@insyra/nest-shared',
});
```

---

## 3. TypeORM DB extractor

### Реальные паттерны

```typescript
// insyra/.../blog-analysis.processor.ts
@InjectRepository(BlogPassports)
private readonly blogPassportsRepo: Repository<BlogPassports>;

// Использование:
await this.blogPassportsRepo.find(...);
await this.blogPassportsRepo.save(...);
```

### Алгоритм

```
1. Найти все @InjectRepository(EntityClass) декораторы
   → захватить EntityClass и enclosing service
   → захватить имя property (для дальнейшего matching call sites)

2. Резолвить EntityClass → найти @Entity декоратор
   → если @Entity('table_name') — используем как table_name
   → если @Entity() — snake_case от имени класса (TypeORM default)

3. Сгенерировать nodes:
   - db-table node для каждой Entity

4. Сгенерировать edges (Phase 1 — без read/write classification):
   - service:X → db-table:Y (kind: 'db-access')

5. (Phase 2 — read/write classification):
   - Анализируем call sites this.<propertyName>.<method>
   - Маппинг:
     find*, count*, exists* → read
     save, insert, update, delete, remove, upsert → write
     createQueryBuilder → unknown (требует доп. анализа)
```

### Cross-DB awareness

Если в проекте несколько `DataSource` (например, `main` + `mssql`), Entity привязана к конкретному DataSource. Захватываем это через:

```typescript
// platform/.../TypeOrmModule.forFeature([Entity], 'mssql')
// → entity Y живёт в datasource 'mssql' → table_node: 'db-table:mssql:Y'
```

---

## 4. BullMQ extractor

### Реальные паттерны

```typescript
// Producer:
@InjectQueue(BLOG_ANALYSIS_QUEUE_NAME) private readonly queue: Queue;
await this.queue.add('job-name', payload);

// Consumer:
@Processor(BLOG_ANALYSIS_QUEUE_NAME, { ... })
export class BlogAnalysisProcessor extends WorkerHost {
    async process(job: Job) { ... }
}

// Registration:
BullModule.registerQueue({ name: BLOG_ANALYSIS_QUEUE_NAME, ... })
```

### Алгоритм

```
1. Найти все BullModule.registerQueue({ name: X }) и registerQueueAsync(...)
   → резолвить X (literal/const) → queue-name
   → enclosing module → owner service

2. Найти все @InjectQueue(X)
   → резолвить X → queue-name
   → edge: service:enclosing → queue:X (kind: 'queue-produce')

3. Найти все @Processor(X, ...)
   → резолвить X → queue-name
   → edge: queue:X → service:enclosing (kind: 'queue-consume')
```

Nodes: `queue:<name>` (например `queue:blog-analysis`, `queue:webhook-delivery`).

---

## 5. HTTP inter-service extractor

Самый шумный extractor: нужно отличать internal calls от external.

### Реальные паттерны

```typescript
this.httpService.post(url, body, { headers });
axios.get(url);
```

### URL resolution

Resolve `url` так же, как NATS subject:
- StringLiteral → literal
- Template `${base}/path` → pattern (где `base` резолвится дальше)
- Identifier → trace через ConfigService.get('SERVICE_X_URL')

### Internal vs external classification

Конфиг определяет какие URL = internal:

```typescript
// arch-graph.config.ts
nats: { ... },
http: {
  internalServices: [
    { id: 'platform-api', envVars: ['PLATFORM_API_URL'], urlPatterns: ['http://localhost:3010', 'http://platform-api'] },
    { id: 'ident', envVars: ['IDENT_URL'] },
    // ...
  ],
},
```

### Алгоритм

```
1. Найти все CallExpression вида:
   - HttpService.{get,post,put,patch,delete}(url, ...)
   - axios.{get,post,...}(url, ...) или axios(config) с config.url
   - fetch(url, ...)

2. Resolve url → ResolvedUrl

3. Match против config.http.internalServices:
   - Если literal содержит pattern → internal
   - Если template начинается с config.get('SERVICE_X_URL') → internal (по envVar)
   - Иначе → external

4. Edges:
   - Internal: service:A → service:B (kind: 'http-call', meta: { method, path })
   - External: service:A → external:<hostname> (kind: 'http-external')
```

---

## 6. NestJS DI extractor (Phase 2)

### Реальные паттерны

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([...]), OtherModule],
  providers: [SomeService],
  exports: [SomeService],
})
export class FooModule {}
```

### Алгоритм

```
1. Найти все классы с декоратором @Module(...)
2. Из аргумента декоратора (ObjectLiteralExpression) извлечь:
   - imports: array of Identifier/CallExpression → module classes
   - providers: array → service classes
   - exports: array → exported services

3. Nodes:
   - module:FooModule
   - provider:SomeService

4. Edges:
   - module:A → module:B (kind: 'di-import')
   - module:A → provider:S (kind: 'di-provides')
   - module:A → provider:S (kind: 'di-exports') — отдельный edge для экспортированных
```

Этот слой полезен для ответа на вопросы типа: "кто использует `BlogPassportService`?" — следуем по экспортам и импортам модулей, потом по injection points.

---

## Merger

После всех extractor'ов:
```
1. Собираем все ExtractResult от всех сервисов
2. Дедупликация nodes по id (subject из 5 сервисов → один node)
3. Сохраняем уникальные edges (по triple (from, to, kind))
4. Аннотируем nodes:
   - nats-subject: список publishers + subscribers
   - db-table: список читающих + пишущих сервисов
   - queue: producer + consumer

5. Записываем graph.json + graph.mermaid
```

---

## Diagnostics

При каждом запуске выводим:
- `unresolved` count по типам (subjects, urls, queue names)
- top 10 неразрешённых случаев с file:line — для уточнения конфига
- new "publish-like" methods candidates — для дополнения publishApis

```bash
$ arch-graph build
✓ services: 8
✓ edges:    nats=247, http=14, db=89, queue=21, di=156, ts-import=4821
⚠ unresolved subjects: 12 (see arch-graph-out/diagnostics.json)
⚠ candidate publish-like methods detected (not in config):
   - NotificationService.sendEvent  (apps/be-notification/.../notification.service.ts:45)
   - MetricsService.recordCommand   (libs/metrics/.../service.ts:88)
```

---

## Граничные случаи и решения

| Кейс | Решение |
|---|---|
| `subject` приходит из external function в `node_modules` | unresolved + лог |
| Subject — runtime значение из БД/конфига | unresolved (по дизайну) |
| Один subject публикуется в 5 сервисах | один node, 5 publish edges |
| `MessagePattern('foo.*')` — wildcard subscribe | pattern node, edge помечен `wildcard: true` |
| `MessagePattern(['a', 'b'])` — массив | два edge'а, по одному на subject |
| ClientProxy proxy через `ClientsModule.registerAsync(...)` | inject token → имя → match по token name |
| `JetStream` vs `Core NATS` | разные edge kinds (`jetstream-publish` vs `nats-publish`) |
| Тестовые файлы (`.spec.ts`) | exclude по умолчанию |
| Mock-клиенты в тестах | exclude через path filter |

---

## Минимальный CLI Phase 1

```bash
arch-graph init                # генерирует arch-graph.config.ts с auto-discovery
arch-graph build               # запускает все extractors
arch-graph build --only=nats   # один extractor
arch-graph build --debug=nats  # подробный лог резолва subjects
arch-graph diagnose            # показывает unresolved + suggestions
```

---

## Следующий шаг

После одобрения этого документа:
1. Создать `package.json` в `arch-graph/` с зависимостями (`ts-morph`, `dependency-cruiser`)
2. Реализовать `ServiceRegistry` + базовый CLI scaffold
3. NATS extractor — самый сложный, начинаем с него
4. Прогон на `insyra/` — получить первый `graph.json`
5. Прогон на `platform/` — проверить более сложные паттерны (typed wrappers)
6. Mermaid output, потом MCP server
