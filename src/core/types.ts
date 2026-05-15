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
    | 'di-import'
    | 'di-provides'
    | 'di-exports'
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
    counts: {
        resolved: number;
        unresolvedEntity: number;
        unowned: number;
        entityDecoratorWarnings: number;
    };
}

export interface DiagnosticsReport {
    projectId: string;
    timestamp: string;
    nats: NatsDiagnostics;
    typeorm: TypeOrmDiagnostics;
    bullmq: BullMqDiagnostics;
    http: HttpDiagnostics;
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
    http: HttpValidationReport;
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
    | { kind: 'unresolved'; raw: string };

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
// HTTP-domain types
// ============================================================================

/**
 * Resolved HTTP URL. The `env-ref` form carries an optional `pathSuffix` so that
 *   `\`${this.baseUrl}/users/${id}\`` where `baseUrl = configService.get('X_URL')`
 * resolves to `{ envVar: 'X_URL', pathSuffix: '/users/*', pathHasParam: true }` —
 * the dominant real-world internal-call pattern.
 *
 * `literal` carries a full URL string (or, when only a path is supplied to a
 * pre-bound baseURL, just the path — that case is not auto-rejoined in v1).
 *
 * `pattern` is reserved for templates whose base couldn't be resolved to either
 * a literal or env-ref. Per the spec it does NOT count toward `resolveRate`.
 */
export type ResolvedUrl =
    | { kind: 'literal'; value: string }
    | { kind: 'env-ref'; envVar: string; pathSuffix?: string; pathHasParam?: boolean }
    | { kind: 'pattern'; pattern: string; placeholders: string[] }
    | { kind: 'unresolved'; raw: string; reason: string };

/** Internal-vs-external classification of a call site, derived from `ResolvedUrl` + config. */
export type HttpTarget =
    | { kind: 'internal'; serviceId: string; via: 'env-ref' | 'url-pattern' }
    | { kind: 'external'; hostname: string }
    | { kind: 'unresolved'; reason: string };

/** Single HTTP-client call site (one row of the extractor's output). */
export interface HttpCallSite {
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
    /**
     * Sites that produced an `http-external` graph edge to `external:<hostname>`.
     * Note: the *validator's* `summary.external` counts a wider set ("not classified
     * internal"), which includes env-refs that don't match any internal-service entry
     * and therefore never produce an edge. The two semantics differ by design — see
     * `HttpValidationReport.summary` for the metric-view definition.
     */
    external: HttpCallSite[];
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
    sites: HttpCallSite[];
    groundTruth: HttpGroundTruthEntry[];
    missed: HttpGroundTruthEntry[];
    extra: HttpCallSite[];
}
