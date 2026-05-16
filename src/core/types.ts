// ============================================================================
// Source locations
// ============================================================================

export interface SourceLoc {
    file: string;
    line: number;
    column: number;
}

// ============================================================================
// NATS-domain types
// ============================================================================

export type EdgeKindNats = 'nats-publish' | 'nats-request' | 'nats-subscribe' | 'nats-reply';

export type ResolvedSubject =
    | { kind: 'literal'; value: string }
    | { kind: 'pattern'; pattern: string; placeholders: string[] }
    | { kind: 'dynamic'; hint: string }
    | { kind: 'unresolved'; raw: string; reason: string };

interface NatsCallSiteBase {
    subject: ResolvedSubject;
    location: SourceLoc;
    via: string;
    enclosingClass?: string;
    /**
     * Inner site of a discovered indirect wrapper (Pattern F). Kept for ground-truth
     * recall, but excluded from resolveRate and the graph — the outer caller emitted
     * by Pass 2 carries the real (resolved) subject for the same logical edge.
     */
    wrapperInternal?: boolean;
}

/** Discriminated union — `role` and `edgeKind` cannot drift apart. */
export type NatsCallSite =
    | (NatsCallSiteBase & { role: 'sender'; edgeKind: 'nats-publish' | 'nats-request' })
    | (NatsCallSiteBase & { role: 'receiver'; edgeKind: 'nats-subscribe' | 'nats-reply' });

export interface WrapperApi {
    class: string;
    methods: string[];
    /**
     * Index of the subject argument in the call. Defaults to 0.
     * Set explicitly (or discovered by Pattern F) for helpers like
     * `NatsRequestHelper.sendWithRetry(client, subject, payload)` where the
     * subject is not the first argument.
     */
    subjectArgIndex?: number;
}

// ============================================================================
// Shared graph schema
// ============================================================================

export type NodeKind =
    | 'service'
    | 'lib'
    | 'nats-subject'
    | 'db-table'
    | 'queue'
    | 'module'
    | 'provider'
    | 'file'
    | 'external';

export type EdgeKind =
    | EdgeKindNats
    | 'http-call'
    | 'http-external'
    | 'queue-produce'
    | 'queue-consume'
    | 'db-read'
    | 'db-write'
    | 'db-access'
    | 'db-relation'
    | 'di-import'
    | 'di-provides'
    | 'di-exports'
    | 'di-controller'
    | 'di-guard'
    | 'di-interceptor'
    | 'di-pipe'
    | 'ts-import'
    | 'lib-usage';

export interface GraphNode {
    id: string;
    kind: NodeKind;
    label: string;
    path?: string;
    meta?: Record<string, unknown>;
}

export interface GraphEdge {
    id: string;
    from: string;
    to: string;
    kind: EdgeKind;
    /** Subject contained runtime params (e.g. `agent.*.events`) */
    dynamic?: boolean;
    subjectPattern?: string;
    file?: string;
    line?: number;
    meta?: Record<string, unknown>;
}

export interface ArchGraph {
    version: string;
    buildAt: string;
    root: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
}

/** Reference to whichever node "owns" (i.e. contains) a call-site — service or lib. */
export type GraphOwnerRef =
    | { kind: 'service'; id: string }
    | { kind: 'lib'; id: string; path: string }
    | { kind: 'unknown'; path: string };

// ============================================================================
// TypeORM-domain types
// ============================================================================

/** @Entity decoration captured during the entity-index pre-pass. */
export interface TypeOrmEntity {
    className: string;
    /** Resolved table name + how it was derived. DU keeps `table` and origin in sync. */
    tableSource:
        | { kind: 'explicit'; table: string }
        | { kind: 'inferred-no-arg'; table: string }
        | { kind: 'inferred-object-no-name'; table: string };
    file: string;
    line: number;
}

/** Convenience accessor — most consumers only need the resolved string. */
export function tableNameOf(e: TypeOrmEntity): string {
    return e.tableSource.table;
}

/**
 * Captured `@ManyToOne` / `@OneToMany` / `@ManyToMany` / `@OneToOne`
 * relation decoration on an entity property.
 *
 * The `target` is the *referenced* entity class name as written in the
 * decorator's type-factory argument (`() => Other`). When the type-factory
 * resolves to a known `@Entity`, the mapper emits a `db-relation` edge
 * `tableA → tableB`. When it doesn't (string token, dynamic expression),
 * the relation is reported in diagnostics with `resolvedTarget = null`.
 */
export interface TypeOrmRelation {
    /** Decorator name as written. */
    decorator: 'ManyToOne' | 'OneToMany' | 'ManyToMany' | 'OneToOne';
    /** Class that owns the property bearing the relation decorator. */
    ownerClass: string;
    /** Property name on the owner class. */
    propertyName: string;
    /** Identifier text in `() => Foo` — empty string if unresolvable. */
    targetClass: string;
    /** Resolved `@Entity` for `targetClass`, or null if unknown. */
    resolvedTarget: TypeOrmEntity | null;
    location: SourceLoc;
}

/** Single `@InjectRepository(EntityClass)` injection site. */
export interface TypeOrmInjectionSite {
    /** Property name on the consuming class (e.g. `blogPassportsRepo`). */
    propertyName: string;
    /** Identifier text used inside `@InjectRepository(...)`. */
    entityClass: string;
    /** Index hit; `null` if the EntityClass isn't a known `@Entity`. */
    resolvedEntity: TypeOrmEntity | null;
    location: SourceLoc;
    enclosingClass?: string;
}

// ============================================================================
// Diagnostics
// ============================================================================

export interface NatsDiagnostics {
    unresolved: NatsCallSite[];
    dynamic: NatsCallSite[];
    /** Call-sites whose owner couldn't be resolved (outside apps/ and libs/). */
    unowned: NatsCallSite[];
    counts: {
        literal: number;
        pattern: number;
        dynamic: number;
        unresolved: number;
    };
}

export type TypeOrmEntityDecoratorWarning =
    | { className: string; file: string; line: number; reason: 'object-literal-missing-name' }
    | { className: string; file: string; line: number; reason: 'non-static-argument'; argKind: string };

export interface TypeOrmDiagnostics {
    /** `@InjectRepository(X)` where X isn't a known `@Entity` (likely external or non-entity). */
    unresolvedEntities: TypeOrmInjectionSite[];
    /** Injection sites outside apps/ and libs/. */
    unowned: TypeOrmInjectionSite[];
    /**
     * `@Entity(...)` decorators with ambiguous table names:
     *   - `object-literal-missing-name`: still indexed with snake_case fallback (likely a developer typo)
     *   - `non-static-argument`: NOT indexed; the entity class appears in `unresolvedEntities` instead
     */
    entityDecoratorWarnings: TypeOrmEntityDecoratorWarning[];
    /**
     * `@ManyToOne / @OneToMany / @ManyToMany / @OneToOne` decorations whose
     * `() => Foo` type-factory didn't resolve to a known entity (string
     * token, dynamic expression, foreign class).
     */
    unresolvedRelations: TypeOrmRelation[];
    counts: {
        resolved: number;
        unresolvedEntity: number;
        unowned: number;
        entityDecoratorWarnings: number;
        relations: number;
        unresolvedRelations: number;
    };
}

export interface DiagnosticsReport {
    projectId: string;
    timestamp: string;
    nats: NatsDiagnostics;
    typeorm: TypeOrmDiagnostics;
    bullmq: BullMqDiagnostics;
    di: DiDiagnostics;
    http: HttpDiagnostics;
    imports: ImportsDiagnostics;
    cycles: CyclesDiagnostics;
}

// ============================================================================
// Cycles — borrowed from dep-cruiser, lives on top of existing ts-import edges
// ============================================================================

/**
 * One detected import cycle. Nodes are absolute file paths (the same ids
 * the imports extractor uses for `ts-import` edges). The cycle is rendered
 * as `[A, B, C]` meaning `A → B → C → A`; the closing back-edge is implicit
 * and never repeated in the array.
 *
 * `kind` distinguishes the layer the cycle was detected on:
 *   - `ts-import` — file-level cycles (typical case)
 *   - `lib-usage` — service/lib-level cycles (architectural-layer cycles)
 *   - `di-import` — `@Module` `imports: [OtherModule]` cycles
 */
export interface ImportCycle {
    kind: 'ts-import' | 'lib-usage' | 'di-import';
    /** At least one node required; a single-element array represents a self-loop. */
    nodes: [string, ...string[]];
    /** Locations of the back-edge for each step (file:line where `import` lives). */
    edgeLocations: Array<{ from: string; to: string; location?: SourceLoc }>;
}

export interface CyclesDiagnostics {
    cycles: ImportCycle[];
    counts: {
        tsImport: number;
        libUsage: number;
        diImport: number;
    };
}

// ============================================================================
// Validation
// ============================================================================

export interface GroundTruthEntry {
    role: 'sender' | 'receiver';
    location: SourceLoc;
    matchedText: string;
    context: string;
}

export interface NatsValidationReport {
    summary: {
        recallHandlers: number;
        recallSenders: number;
        resolveRate: number;
        classificationAccuracy: number;
        totalExtracted: number;
        totalGroundTruth: number;
        /** Per-role ground-truth counts — the gate enforces non-zero per role separately. */
        groundTruthHandlers: number;
        groundTruthSenders: number;
        bySubjectKind: Record<string, number>;
    };
    extracted: NatsCallSite[];
    groundTruth: GroundTruthEntry[];
    missed: GroundTruthEntry[];
    extra: NatsCallSite[];
    unresolvedSamples: NatsCallSite[];
}

export interface TypeOrmGroundTruthEntry {
    role: 'injection' | 'entity';
    location: SourceLoc;
    matchedText: string;
    /** For `injection`: the EntityClass identifier text. For `entity`: the table-name text (or empty for `@Entity()`). */
    context: string;
}

export interface TypeOrmValidationReport {
    summary: {
        recallInjections: number;
        recallEntities: number;
        /** Fraction of extracted injections that resolved to a known entity. */
        resolveRate: number;
        totalInjections: number;
        totalEntities: number;
        groundTruthInjections: number;
        groundTruthEntities: number;
    };
    injections: TypeOrmInjectionSite[];
    entities: TypeOrmEntity[];
    groundTruth: TypeOrmGroundTruthEntry[];
    missedInjections: TypeOrmGroundTruthEntry[];
    missedEntities: TypeOrmGroundTruthEntry[];
    extraInjections: TypeOrmInjectionSite[];
}

export interface BuildValidation {
    projectId: string;
    timestamp: string;
    nats: NatsValidationReport;
    typeorm: TypeOrmValidationReport;
    bullmq: BullMqValidationReport;
    di: DiValidationReport;
    http: HttpValidationReport;
    imports: ImportsValidationReport;
}

// ============================================================================
// BullMQ-domain types
// ============================================================================

/**
 * Resolved (or failed-to-resolve) queue name + how it was derived. Similar
 * shape to `TypeOrmEntity.tableSource`, but adds an `unresolved` variant for
 * dynamic / non-static arguments — TypeORM's tableSource always resolves
 * (snake_case is the last-resort default), BullMQ's queue name can't be
 * inferred at all when the argument isn't a known constant.
 */
export type BullMqQueueRef =
    | { kind: 'literal'; name: string }
    | { kind: 'const'; name: string; identifier: string }
    | {
          kind: 'unresolved';
          raw: string;
          /**
           * Structured reason for why the queue name could not be resolved:
           *
           *   `no-arg`               — decorator called with zero arguments (`@Processor()`).
           *                           (typically decorator)
           *   `unindexed-identifier` — identifier / dotted-path not found in QueueNameIndex;
           *                           may be a non-exported const, an import from an unscanned
           *                           file, or a typo. (typically decorator)
           *   `options-no-name`      — object-literal form of `@Processor` / `@InjectQueue`
           *                           has no `name` property (`@Processor({ concurrency: 3 })`).
           *                           (typically decorator)
           *   `dynamic-expression`   — argument is a template literal, function call, ternary,
           *                           binary expression, or other non-static node kind.
           *                           (typically decorator)
           *   `no-name-property`     — `registerQueue({ ... })` object has no `name` field.
           *                           (registration only)
           *   `non-object-arg`       — `registerQueue(expr)` argument is not an object literal.
           *                           (registration only)
           */
          reason:
              | 'no-arg'
              | 'unindexed-identifier'
              | 'options-no-name'
              | 'dynamic-expression'
              | 'no-name-property'
              | 'non-object-arg';
      };

interface BullMqSiteBase {
    queue: BullMqQueueRef;
    location: SourceLoc;
    enclosingClass?: string;
}

/** `@InjectQueue(NAME)` — producer site. */
export interface BullMqInjectionSite extends BullMqSiteBase {
    role: 'producer';
    propertyName: string;
}

/** `@Processor(NAME, options?)` class — consumer site. */
export interface BullMqProcessorSite extends BullMqSiteBase {
    role: 'consumer';
    className: string;
}

/**
 * `BullModule.registerQueue({ name })` / `registerQueueAsync(...)` — declares the
 * queue boundary. Multiple registrations of the same name are allowed (per-module).
 *
 * `role: 'registration'` makes every BullMQ site carry a discriminant, so consumers
 * iterating over `BullMqDiagnostics.unresolved` can branch on `role` exhaustively.
 */
export interface BullMqQueueRegistration {
    role: 'registration';
    queue: BullMqQueueRef;
    api: 'registerQueue' | 'registerQueueAsync';
    location: SourceLoc;
}

export type BullMqSite = BullMqInjectionSite | BullMqProcessorSite | BullMqQueueRegistration;

export interface BullMqDiagnostics {
    /**
     * Sites whose queue name couldn't be resolved (dynamic / non-static argument).
     * Every entry has `queue.kind === 'unresolved'` (enforced by mapper, not the type).
     */
    unresolved: BullMqSite[];
    /** Producer/consumer sites outside apps/ and libs/. Registrations have no owner. */
    unowned: Array<BullMqInjectionSite | BullMqProcessorSite>;
    counts: {
        producers: number;
        consumers: number;
        registrations: number;
        unresolved: number;
        unowned: number;
    };
}

export interface BullMqGroundTruthEntry {
    role: 'producer' | 'consumer' | 'registration';
    location: SourceLoc;
    matchedText: string;
    /** Raw queue-name token (Identifier text or quoted literal contents). */
    context: string;
}

export interface BullMqValidationReport {
    summary: {
        recallProducers: number;
        recallConsumers: number;
        recallRegistrations: number;
        /**
         * Fraction of (producers + consumers + registrations) that resolved to a
         * known queue name. Returns 0 when there are no extracted sites (not NaN).
         */
        resolveRate: number;
        totalProducers: number;
        totalConsumers: number;
        totalRegistrations: number;
        groundTruthProducers: number;
        groundTruthConsumers: number;
        groundTruthRegistrations: number;
    };
    producers: BullMqInjectionSite[];
    consumers: BullMqProcessorSite[];
    registrations: BullMqQueueRegistration[];
    groundTruth: BullMqGroundTruthEntry[];
    missedProducers: BullMqGroundTruthEntry[];
    missedConsumers: BullMqGroundTruthEntry[];
    missedRegistrations: BullMqGroundTruthEntry[];
    extraProducers: BullMqInjectionSite[];
    extraConsumers: BullMqProcessorSite[];
    extraRegistrations: BullMqQueueRegistration[];
}

export function queueNameOf(ref: BullMqQueueRef): string | null {
    return ref.kind === 'unresolved' ? null : ref.name;
}

// ============================================================================
// DI-domain types (NestJS @Module)
// ============================================================================

/**
 * Resolved reference inside `imports: [...]`. Three shapes:
 *   - bare identifier `OtherModule`            → `class` (module class name)
 *   - call expression `Foo.forRoot(...)`       → `dynamic` (callee root identifier; arguments ignored)
 *   - anything else (spread, ternary, etc.)    → `unresolved` (skip + diagnostic)
 *
 * The `class` form is the common case; the resulting graph edge points at
 * `module:<name>`. The `dynamic` form is what NestJS calls a "dynamic module"
 * factory — we record the producing module class as the edge target, which is
 * the natural unit of architectural dependency.
 */
export type DiModuleRef =
    | { kind: 'class'; name: string }
    | { kind: 'dynamic'; name: string; via: string }
    | { kind: 'unresolved'; raw: string; reason: string };

/**
 * Resolved reference inside `providers: [...]` / `exports: [...]`.
 *
 *   - bare identifier `FooService`             → `class` (provider class name)
 *   - bare string literal `'MY_TOKEN'`         → `token-ref` (string re-export of a token declared elsewhere)
 *   - object literal `{ provide, useClass }`   → `token` with one of:
 *       - `useClass: Foo`     → name = `Foo`,    providerKind = 'class'
 *       - `useExisting: Foo`  → name = `Foo`,    providerKind = 'existing'
 *       - `useValue: ...`     → name = provideTokenText, providerKind = 'value'
 *       - `useFactory: ...`   → name = provideTokenText, providerKind = 'factory'
 *   - object literal `{ provide }` without useX → `unresolved` (reason: 'provide-without-use-key')
 *   - anything else (spread, ternary)          → `unresolved`
 *
 * The `token-ref` variant models the NestJS pattern of re-exporting a token by its
 * string name: `exports: ['MY_TOKEN']`. The token was declared (with `useClass/Value/Factory`)
 * elsewhere in the same module; here it is only referenced by name.
 */
export type DiProviderRef =
    | { kind: 'class'; name: string }
    | {
          kind: 'token';
          name: string;
          providerKind: 'class' | 'existing' | 'value' | 'factory';
          /** Original `provide:` token text when it differs from `name` (e.g. `provide: TOKEN, useClass: FooImpl`). */
          provideToken?: string;
      }
    | {
          /**
           * Bare string (or no-substitution template) literal in `providers` / `exports` position:
           *   `exports: ['MY_TOKEN']`
           *
           * The token may be declared in this module's `providers` array via
           * `{ provide: 'MY_TOKEN', useX: ... }`, or it may have been provided by an
           * imported module and re-exported here by string name. This ref is a pointer-by-name
           * to that declaration, not a new provider definition.
           *
           * No `providerKind` is set on this ref's edge; the concrete kind is carried by the
           * companion `di-provides` edge (which may live in this module or an imported one).
           * If the companion is missing entirely (orphan re-export of a token nobody defines),
           * the resulting `provider:<name>` graph node will have empty `meta` — there is
           * intentionally no synthetic placeholder.
           */
          kind: 'token-ref';
          name: string;
      }
    | { kind: 'unresolved'; raw: string; reason: string };

/**
 * Reference inside `controllers: [...]`. NestJS only accepts a class identifier
 * here — `{ provide: ..., useFactory: ... }` / `{ provide: ..., useValue: ... }`
 * are not legal in this position (the runtime rejects them with a type error).
 *
 * Modelling this as a narrower union than `DiProviderRef` removes the structural
 * possibility of emitting a `value`/`factory` controller. Anything that doesn't
 * decode to a class identifier becomes `unresolved` with a structured reason.
 */
export type DiControllerRef =
    | { kind: 'class'; name: string }
    | { kind: 'unresolved'; raw: string; reason: string };

/** One `@Module(...)` declaration. */
export interface DiModuleSite {
    className: string;
    /** Position of the `@Module` decorator itself — used by `module` GT matching. */
    location: SourceLoc;
    imports: DiModuleRef[];
    providers: DiProviderRef[];
    exports: DiProviderRef[];
    controllers: DiControllerRef[];
    /**
     * Per-field property-name locations inside the metadata object, when present.
     * Used by the validator to match `<field>-field` GT by file:line (presence-recall).
     */
    fieldLocations: {
        imports: SourceLoc | null;
        providers: SourceLoc | null;
        exports: SourceLoc | null;
        controllers: SourceLoc | null;
    };
    /**
     * Flags signalling that a field contained spread, ternary, or other dynamic
     * expressions we couldn't enumerate. Downstream tooling uses these to decide
     * whether to trust the resolved ref list as "complete" for that field —
     * a single unresolved entry breaks that contract.
     *
     * Field-presence (was a `<field>:` written at all?) is encoded by `fieldLocations.X !== null`;
     * no separate boolean is needed.
     */
    flags: {
        hasDynamicImports: boolean;
        hasDynamicProviders: boolean;
        hasDynamicExports: boolean;
        hasDynamicControllers: boolean;
    };
}

export interface DiDiagnostics {
    /** Refs (across all four arrays) that couldn't be resolved to a class name. */
    unresolvedRefs: Array<{
        moduleClass: string;
        field: 'imports' | 'providers' | 'exports' | 'controllers';
        ref: DiModuleRef | DiProviderRef | DiControllerRef;
        location: SourceLoc;
    }>;
    /** `@Module`-decorated classes whose owning file falls outside apps/ and libs/. */
    unowned: DiModuleSite[];
    /**
     * `@UseGuards / @UseInterceptors / @UsePipes` decorations whose arguments
     * couldn't be resolved to a class identifier (spread, ternary, factory call).
     */
    unresolvedFilterRefs: DiFilterChainRef[];
    counts: {
        modules: number;
        imports: number;
        providers: number;
        exports: number;
        controllers: number;
        unresolvedRefs: number;
        unowned: number;
        guards: number;
        interceptors: number;
        pipes: number;
        unresolvedFilterRefs: number;
    };
}

// ============================================================================
// DI filter chain — @UseGuards / @UseInterceptors / @UsePipes
// ============================================================================

export type DiFilterDecorator = 'UseGuards' | 'UseInterceptors' | 'UsePipes';

/**
 * Resolved reference inside `@UseGuards(...)` / `@UseInterceptors(...)` /
 * `@UsePipes(...)`. Same three shapes as `DiProviderRef.class` / token / etc.,
 * but the decorator only legally accepts class identifiers or new'd instances
 * (the latter is recorded as `instance` — same edge target, different kind).
 *
 * Examples:
 *   `@UseGuards(AuthGuard)`             → `class { name: 'AuthGuard' }`
 *   `@UseInterceptors(new LoggingI())`  → `instance { name: 'LoggingI' }`
 *   `@UsePipes(...spread)`              → `unresolved`
 */
export type DiFilterChainRef =
    | {
          kind: 'class';
          name: string;
          decorator: DiFilterDecorator;
          location: SourceLoc;
          /** Class / method this decoration sits on. */
          enclosingClass: string;
          /** `class` if on the class itself, `method:methodName` if on a handler. */
          attachedTo: { kind: 'class' } | { kind: 'method'; methodName: string };
      }
    | {
          kind: 'instance';
          name: string;
          decorator: DiFilterDecorator;
          location: SourceLoc;
          enclosingClass: string;
          attachedTo: { kind: 'class' } | { kind: 'method'; methodName: string };
      }
    | {
          kind: 'unresolved';
          raw: string;
          reason: string;
          decorator: DiFilterDecorator;
          location: SourceLoc;
          enclosingClass: string;
          attachedTo: { kind: 'class' } | { kind: 'method'; methodName: string };
      };

// ============================================================================
// HTTP-domain types
// ============================================================================

/**
 * Resolved HTTP URL. The `env-ref` form carries an optional nested `path` so that
 *   `\`${this.baseUrl}/users/${id}\`` where `baseUrl = configService.get('X_URL')`
 * resolves to `{ envVar: 'X_URL', path: { suffix: '/users/*', hasParam: true } }` —
 * the dominant real-world internal-call pattern.
 *
 * The nested DU enforces the co-invariant: previously `pathSuffix?` and `pathHasParam?`
 * were independent optionals, but they're either both present (env-ref with a path
 * tail) or both absent (bare env-ref like `axios.get(configService.get('X_URL'))`).
 * Nesting them under a single `path?` makes that constraint structural.
 *
 * `literal` carries a full URL string (or, when only a path is supplied to a
 * pre-bound baseURL, just the path — that case is not auto-rejoined in v1).
 *
 * `pattern` is reserved for templates whose base couldn't be resolved to either
 * a literal or env-ref. Per the spec it does NOT count toward `resolveRate`.
 */
export type ResolvedUrl =
    | { kind: 'literal'; value: string }
    | { kind: 'env-ref'; envVar: string; path?: { suffix: string; hasParam: boolean } }
    | { kind: 'pattern'; pattern: string; placeholders: string[] }
    | { kind: 'unresolved'; raw: string; reason: string };

/** Internal-vs-external classification of a call site, derived from `ResolvedUrl` + config. */
export type HttpTarget =
    | { kind: 'internal'; serviceId: string; via: 'env-ref' | 'url-pattern' }
    | { kind: 'external'; hostname: string }
    | { kind: 'unresolved'; reason: string };

/** Single HTTP-client call site (one row of the extractor's output). */
export interface HttpCallSite {
    /**
     * Discriminant matching the convention of every other domain (NATS sender/receiver,
     * BullMQ producer/consumer/registration, Imports static). HTTP currently has a single
     * role; the field is fixed at `'call'` to keep exhaustive switches in shape if/when
     * additional roles appear (e.g. `'webhook-receive'`).
     */
    role: 'call';
    /** Resolved-or-not URL expression. */
    url: ResolvedUrl;
    /** HTTP method: 'get' | 'post' | ... | 'fetch' | 'unknown' (axios(config) etc). */
    method: string;
    /** What we matched: 'httpService' | 'axios' | 'fetch' | etc — for diagnostics + via meta. */
    api: HttpApi;
    location: SourceLoc;
    enclosingClass?: string;
}

export type HttpApi = 'httpService' | 'axios' | 'fetch';

export interface HttpDiagnostics {
    /**
     * Sites that could NOT be mapped to *any* graph edge — either the URL didn't
     * resolve at all, or it resolved to an env-ref / pattern with no matching
     * internal-services entry and no extractable hostname.
     *
     * NB: Distinct from `HttpValidationReport.summary.unresolvedClassification`,
     * which counts the same "unresolved-for-metric" set (anything not literal+host
     * or env-ref-matched-internal). This list is the graph-attribution view; the
     * validator's count is the resolve-metric view.
     */
    unresolved: HttpCallSite[];
    /** Sites outside apps/ and libs/. */
    unowned: HttpCallSite[];
    counts: {
        totalSites: number;
        literal: number;
        envRef: number;
        pattern: number;
        unresolved: number;
        internal: number;
        external: number;
        unowned: number;
    };
}

export interface DiGroundTruthEntry {
    /**
     * `module`         — one `@Module(` decorator.
     * `imports-field`  — one `imports:` property inside any `@Module({...})`.
     * `providers-field`/`exports-field`/`controllers-field` — analogous.
     *
     * Field-presence GT (not entry-counting) is robust against multiline arrays,
     * nested calls, spreads, comments — count of *populated fields per module*, not
     * the count of array entries. The extractor records the location in
     * `fieldLocations.X` (non-null = present) whenever it sees the property
     * assignment; matching is by file:line of the property-name keyword.
     */
    role: 'module' | 'imports-field' | 'providers-field' | 'exports-field' | 'controllers-field';
    location: SourceLoc;
    matchedText: string;
}

export interface DiValidationReport {
    summary: {
        /** Fraction of `@Module(` occurrences in source that correspond to an extracted module site. */
        recallModules: number;
        recallImportsFields: number;
        recallProvidersFields: number;
        recallExportsFields: number;
        recallControllersFields: number;
        /**
         * Fraction of (imports + providers + exports + controllers) refs that resolved
         * to a class/token name (not `unresolved`). Returns 1 (vacuously perfect) when
         * there are no refs at all, matching the convention used by other domain reports.
         */
        resolveRate: number;
        totalModules: number;
        totalImports: number;
        totalProviders: number;
        totalExports: number;
        totalControllers: number;
        groundTruthModules: number;
        groundTruthImportsFields: number;
        groundTruthProvidersFields: number;
        groundTruthExportsFields: number;
        groundTruthControllersFields: number;
    };
    modules: DiModuleSite[];
    groundTruth: DiGroundTruthEntry[];
    missedModules: DiGroundTruthEntry[];
    missedImportsFields: DiGroundTruthEntry[];
    missedProvidersFields: DiGroundTruthEntry[];
    missedExportsFields: DiGroundTruthEntry[];
    missedControllersFields: DiGroundTruthEntry[];
    extraModules: DiModuleSite[];
}

export interface HttpGroundTruthEntry {
    role: 'call';
    location: SourceLoc;
    matchedText: string;
    /** API marker: 'httpService.<method>' | 'axios.<method>' | 'fetch'. */
    context: string;
}

export interface HttpValidationReport {
    summary: {
        recallCalls: number;
        /**
         * Fraction of extracted sites that resolved to a *useful* form, per the spec:
         *   literal URL  ∨  env-ref matched to a configured internal service.
         *
         * Unresolved external URLs and env-refs that don't match any internal-service
         * envVar do NOT count as resolved — they're real recall but no graph edge to a
         * named target. Returns 0 when there are no extracted sites (not NaN).
         */
        resolveRate: number;
        totalSites: number;
        groundTruthCalls: number;
        /**
         * Resolve-metric classification (informational; for graph-attribution view see
         * `HttpDiagnostics`):
         *   `internal`                 — env-ref matched, OR literal URL whose host
         *                                matches `internalServices[*].urlPatterns`
         *   `external`                 — env-ref NOT matched, OR literal URL with a host
         *                                that didn't match an internal pattern. The
         *                                latter ("external-literal") becomes a graph
         *                                edge; the former does NOT (no hostname).
         *   `unresolvedClassification` — pattern / unresolved (no useful target)
         */
        internal: number;
        external: number;
        unresolvedClassification: number;
    };
    /**
     * Informational data that is neither a recall miss nor an error — successfully
     * classified call sites that fall outside the internal-service graph.
     *
     * Separated from `HttpDiagnostics` (which only contains failures: `unresolved`
     * and `unowned`) to reflect the semantic asymmetry: `externalCalls` entries are
     * correctly extracted and correctly classified; they are NOT diagnostic failures.
     *
     * `externalCalls` uses the validator's classification view (same pass as
     * `summary.external`), which counts *both* external-literal sites (that produce a
     * graph edge) and env-refs unmatched to any internal service (diagnostic-only, no
     * graph edge). For the narrower graph-edge-only count, see `HttpDiagnostics.counts.external`.
     */
    informational: {
        externalCalls: HttpCallSite[];
    };
    sites: HttpCallSite[];
    groundTruth: HttpGroundTruthEntry[];
    missed: HttpGroundTruthEntry[];
    extra: HttpCallSite[];
}

// ============================================================================
// TS-imports domain types
// ============================================================================

/**
 * Resolution outcomes that can appear on a *static* `import` declaration.
 *
 * Does not include `dynamic-non-literal` — that variant is structurally
 * impossible on a static import where the specifier is always a string literal
 * known at parse time.
 *
 * Variants:
 *   - `resolved`        — specifier resolved to a file on disk; `filePath` is
 *                         the absolute path. This is the success case.
 *   - `external`        — specifier is a node_modules package or Node.js
 *                         builtin. `packageName` is the canonical npm package
 *                         name (e.g. `@nestjs/common`) or Node builtin URL
 *                         (e.g. `node:fs`). No graph edge.
 *   - `broken-alias`    — specifier matched a tsconfig `paths` prefix but the
 *                         on-disk probe failed. Real bug signal.
 *   - `broken-relative` — specifier starts with `./` or `../` but no file was
 *                         found on disk after all TS-extension probes.
 */
export type TsStaticResolution =
    | { kind: 'resolved'; filePath: string }
    | { kind: 'external'; packageName: string }
    | { kind: 'broken-alias'; reason: 'alias-prefix-matched-file-not-found' }
    | { kind: 'broken-relative'; reason: 'file-not-found' };

/**
 * Resolution outcomes that can appear on a *dynamic* `import(...)` call.
 *
 * Extends `TsStaticResolution` with `dynamic-non-literal`: the case where the
 * import argument is a variable / template-with-substitutions and resolution is
 * structurally impossible without taint analysis.
 *
 *   - `dynamic-non-literal` — `import(expr)` where `expr` is not a string
 *                             literal. The intentional skip is made explicit here
 *                             rather than leaking a `null`.
 */
export type TsDynamicResolution =
    | TsStaticResolution
    | { kind: 'dynamic-non-literal' };

/**
 * Back-compat alias: the full set of resolution outcomes across both static and
 * dynamic import sites. Equals `TsDynamicResolution`.
 *
 * Exported so external consumers that already import `TsImportResolution` are
 * not broken. New code should prefer the narrower `TsStaticResolution` or the
 * wider `TsDynamicResolution` depending on the site kind.
 */
export type TsImportResolution = TsDynamicResolution;

/**
 * One `import` declaration captured during the imports extractor walk.
 *
 *  - `specifier`  — raw module specifier text (e.g. `"@scope/messaging"`).
 *  - `resolution` — discriminated union describing the resolution outcome.
 *                   The `kind` field determines which resolution variants are
 *                   structurally possible:
 *                     `static`  → `TsStaticResolution`  (no `dynamic-non-literal`)
 *                     `dynamic` → `TsDynamicResolution`  (all five variants)
 *                   This invariant is enforced structurally by the DU below;
 *                   the compiler rejects `{ kind: 'static', resolution: { kind: 'dynamic-non-literal' } }`.
 *  - `typeOnly`   — `import type { X } from ...`. Still produces graph edges:
 *                   a type-only dep is still a structural lib usage.
 *  - `specifierShape` — raw source-text classification of the specifier form.
 *                   Set on all sites including resolved ones; available to
 *                   diagnostics and external consumers. Independent of
 *                   `resolution` (which describes the outcome, not the form).
 */
export type TsImportSite =
    | {
          sourceFile: string;
          specifier: string;
          resolution: TsStaticResolution;
          kind: 'static';
          typeOnly: boolean;
          specifierShape: 'relative' | 'alias' | 'bare-external' | 'builtin';
          location: SourceLoc;
      }
    | {
          sourceFile: string;
          specifier: string;
          resolution: TsDynamicResolution;
          kind: 'dynamic';
          typeOnly: boolean;
          specifierShape: 'relative' | 'alias' | 'bare-external' | 'builtin';
          location: SourceLoc;
      }
    | {
          /**
           * CommonJS `require(...)` call. Captured for legacy / Node-builtin
           * usages that still appear in mostly-ESM TS codebases. Resolution
           * model mirrors `dynamic` — the specifier may be non-literal at
           * the call site (`require(varName)`), producing
           * `dynamic-non-literal`.
           */
          sourceFile: string;
          specifier: string;
          resolution: TsDynamicResolution;
          kind: 'cjs-require';
          typeOnly: false;
          specifierShape: 'relative' | 'alias' | 'bare-external' | 'builtin';
          location: SourceLoc;
      };

export interface ImportsDiagnostics {
    /**
     * Static imports with a `broken-alias` or `broken-relative` resolution — i.e.
     * specifiers that look internal but didn't resolve to a file on disk. These are
     * the suspicious ones: typo'd path aliases, missing `paths` entries, moved files.
     */
    unresolvedImports: TsImportSite[];
    /** Dynamic `import(...)` calls — kept for visibility, not gated. */
    dynamicImports: TsImportSite[];
    /** CommonJS `require(...)` calls — kept for visibility, not gated. */
    cjsRequires: TsImportSite[];
    counts: {
        totalStatic: number;
        totalDynamic: number;
        totalCjsRequire: number;
        resolvedToOwner: number;
        externalOrUnresolved: number;
        unresolvedInternal: number;
    };
}

export interface ImportsGroundTruthEntry {
    /**
     * Discriminant for parity with other GT entry types (`module`/`call`/`producer`/...).
     * Imports recall today only tracks static `import ... from '...'` declarations;
     * dynamic `import(...)` is captured by the extractor but excluded from GT.
     */
    role: 'static';
    location: SourceLoc;
    matchedText: string;
    typeOnly: boolean;
}

export interface ImportsValidationReport {
    summary: {
        /**
         * `extracted_static / GT_static`, computed across all files. ts-morph and
         * the regex see the same per-file totals when extraction is healthy; a
         * drop here usually means a whole file (or a wide swath) was excluded.
         */
        recallStatic: number;
        /**
         * Per-file recall floor — min over files where GT >= 1. Catches the
         * single-file regression that an aggregate average would dilute away.
         */
        minPerFileRecall: number;
        totalStatic: number;
        groundTruthStatic: number;
        filesWithImports: number;
        /** Files where extracted < GT by at least 1; sorted, capped to first 20. */
        filesUnderRecall: Array<{ file: string; extracted: number; groundTruth: number }>;
    };
}
