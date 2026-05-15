# arch-graph — roadmap

Зафиксированы все решения из сессии требований. Код не пишем до окончания `02-extractors-design.md`.

---

## Итоги сессии требований

### Стек (подтверждён из кода insyra + platform)

- **NestJS** — оба монорепо, DI через `@Module` / `@Injectable`
- **NATS через `@nestjs/microservices`**: `@MessagePattern` на стороне handler'а, `ClientProxy.send/emit` на стороне отправителя
- **Subjects**: типизированные константы (`NATS_SUBJECTS.EVENTS.AGENT_ENROLLED`) + динамические функции (`DELIVER: (agentId) => \`agent.${agentId}.commands.deliver\``)
- **BullMQ** — оба проекта, очереди как async-слой внутри и между модулями
- **TypeORM** — оба проекта
- **HTTP inter-service** — есть (подтверждено пользователем)
- **OpenTelemetry** — в platform установлен и подключён к Jaeger/Tempo

### Решения

| Вопрос | Решение |
|---|---|
| Rebuild mode | Ondemand (`arch-graph build`) |
| Output форматы | `graph.json` (MCP) + Mermaid/Graphviz |
| Open-source / internal | Internal-only |
| 2-brain MCP-мост | Нужен, Phase 4 |
| Runtime tracing (OTel) | Да, Jaeger/Tempo есть → Phase 3 |
| HTTP inter-service | Включить в граф |
| BullMQ очереди | Включить как queue-edges |
| DI-граф NestJS | Phase 2 (после baseline) |

---

## Граф: типы рёбер (edges)

```
service-A —@MessagePattern→ nats-subject ←ClientProxy.send— service-B   (NATS request-reply)
service-A —ClientProxy.emit→ nats-subject ←@EventPattern— service-B      (NATS fire-and-forget)
service-A —HttpService.get→ service-B                                     (HTTP inter-service)
service-A —@InjectQueue→ queue-name ←@Processor— service-A               (BullMQ)
service-A —TypeORM Repository<Entity>→ db-table                           (DB access)
module-A —imports→ module-B (exports ServiceX)                            (NestJS DI)
service-A —OTel span→ service-B (frequency, latency)                      (runtime)
```

---

## Фазы

### Phase 1 — Baseline static graph (MVP)

**Цель**: работающий `arch-graph build` на реальном монорепо, граф в `arch-graph-out/graph.json`.

**Extractors**:
1. **TS import-graph** — dependency-cruiser → JSON → нормализация в общую схему
2. **NATS extractor** (ts-morph):
   - Сканируем `@MessagePattern('...')` → listener nodes
   - Сканируем `ClientProxy.send(subject, ...)` и `.emit(subject, ...)` → sender edges
   - Резолвим subject-константы статически через ts-morph type inference
   - Динамические subjects (`(id) => \`...\``) → placeholder `dynamic:prefix.*`

**CLI**:
```bash
arch-graph build [--root ./] [--out ./arch-graph-out]
arch-graph build --service apps/platform-api  # single service
```

**Output**: `arch-graph-out/graph.json` (схема ниже)

**Deliverable**: можно задать вопрос "кто публикует на subject X?" и получить ответ из JSON.

---

### Phase 2 — Full static graph

**Цель**: все статические слои + Mermaid output + MCP server.

**Новые extractors**:
3. **TypeORM DB extractor** (ts-morph):
   - Сканируем `@InjectRepository(EntityClass)` → edge `service → table-name`
   - Fallback: `@Entity('table_name')` / `@Entity()` (имя класса → snake_case)
   - Типы доступа: read / write / both (из вызовов `.find`, `.save`, `.delete`)
4. **BullMQ extractor** (ts-morph):
   - `BullModule.registerQueue({ name })` → очередь существует в сервисе
   - `@InjectQueue(name)` + вызовы `.add(...)` → producer edge
   - `@Processor(name)` + `@Process(...)` → consumer edge
5. **HTTP extractor** (ts-morph):
   - Сканируем `HttpService.get/post(url)` и `axios.*(url)`
   - Резолвим url: если `configService.get('SERVICE_URL')` или env-константа → пытаемся сопоставить с известными сервисами
   - Нераспознанные URL → помечаем как `external`
6. **NestJS DI extractor** (ts-morph):
   - Сканируем `@Module({ imports, exports, providers })` → edges `module imports module`
   - Граф Nest-модулей как отдельный слой (`kind: "di"`)

**Output**: `arch-graph-out/graph.json` + `arch-graph-out/graph.mermaid`

**MCP server**:
```
arch-graph mcp  # запускает MCP server на stdio
```
Инструменты:
- `query(subject)` — кто publish/subscribe на subject
- `service_deps(serviceName)` — все зависимости сервиса
- `path(from, to)` — путь между двумя сервисами
- `explain(node)` — описание узла с контекстом

---

### Phase 3 — Runtime layer (OTel/Jaeger)

**Цель**: обогатить статический граф реальными частотами и латентностями.

**Реализация**:
- `arch-graph runtime --jaeger http://localhost:16686` — запрашивает Jaeger HTTP API
- Получаем traces за N дней → агрегируем spans по `service → service` pairs
- Merge с существующим `graph.json`: добавляем к рёбрам поля `runtime.callCount`, `runtime.p50`, `runtime.p99`, `runtime.errorRate`
- Рёбра без static-эквивалента помечаются как `discovered: true` (найдено только в runtime)

**Ценность**: показывает "мёртвые" связи (в коде есть, реально не вызывается) и "горячие" пути.

---

### Phase 4 — 2-brain MCP bridge

**Цель**: arch-graph как data source для memory-системы 2-brain.

**Реализация**:
- В 2-brain Phase 3 MCP-tool `memory.code_context(query)` проксирует к arch-graph MCP если `arch-graph.json` найден в проекте
- arch-graph MCP server уже готов из Phase 2
- Добавляем discovery: 2-brain ищет `arch-graph-out/graph.json` в корне проекта

---

## graph.json — предварительная схема

```typescript
interface ArchGraph {
  version: string;          // "1.0"
  buildAt: string;          // ISO timestamp
  root: string;             // absolute path to monorepo root
  nodes: Node[];
  edges: Edge[];
}

interface Node {
  id: string;               // "service:be-ai", "nats:platform.ai.completion", "table:blog_passport", "queue:blog-analysis"
  kind: "service" | "nats-subject" | "db-table" | "queue" | "module";
  label: string;
  path?: string;            // file path для service/module
  meta?: Record<string, unknown>;
}

interface Edge {
  id: string;
  from: string;             // node id
  to: string;               // node id
  kind: "nats-publish" | "nats-subscribe" | "nats-request" | "nats-reply"
       | "http-call" | "queue-produce" | "queue-consume"
       | "db-read" | "db-write" | "di-import" | "ts-import";
  dynamic?: boolean;        // subject содержит runtime-параметр
  subjectPattern?: string;  // для dynamic: "agent.*.commands.deliver"
  // runtime (Phase 3)
  runtime?: {
    callCount?: number;
    p50ms?: number;
    p99ms?: number;
    errorRate?: number;
  };
  // source location
  file?: string;
  line?: number;
}
```

---

## Структура проекта

```
arch-graph/
├── 00-briefing.md
├── 01-roadmap.md          ← этот файл
├── 02-extractors-design.md ← следующий шаг: детальный дизайн каждого extractor'а
├── 03-mcp-interface.md    ← после Phase 2: API для LLM-агентов
└── src/                   ← когда дойдёт до кода
    ├── cli/
    ├── extractors/
    │   ├── dependency-cruiser.extractor.ts
    │   ├── nats.extractor.ts
    │   ├── typeorm.extractor.ts
    │   ├── bullmq.extractor.ts
    │   ├── http.extractor.ts
    │   └── nestjs-di.extractor.ts
    ├── merger/            ← объединяет выходы всех extractor'ов
    ├── output/
    │   ├── graph-json.writer.ts
    │   └── mermaid.writer.ts
    ├── mcp/               ← Phase 2
    └── runtime/           ← Phase 3
        └── jaeger.importer.ts
```

---

## Следующий шаг

Написать `02-extractors-design.md` — детальный технический дизайн каждого extractor'а:
- Как именно сканируем AST для NATS (примеры из реального кода insyra/platform)
- Как резолвим subject-константы (включая динамические функции)
- Что делаем с `ClientProxy` инжекцией (нужно трассировать inject token → конкретный NATS client)
- Граничные случаи HTTP extractor'а (как отличить internal от external)
