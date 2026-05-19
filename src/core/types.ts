// ============================================================================
// Branded types
// ============================================================================

/**
 * Branded newtype for graph node anchor strings.
 *
 * Prevents accidental assignment of arbitrary strings to `GraphNode.anchor`.
 * Construct via `buildClassMemberAnchor` (for "Class.member" form) or
 * `buildAnchor` (for bare-name forms like config keys or class names).
 */
export type Anchor = string & { readonly __anchor: unique symbol };

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
    | 'external'
    | 'fe-page'
    | 'fe-component'
    | 'fe-route'
    | 'fe-hook'
    | 'endpoint'
    | 'config-field'
    /** STUB: extractor returns empty in v1 — see B8 in design doc */
    | 'scoped-marker'
    | 'db-entity-field'
    | 'doc-section'
    /** @nestjs/schedule cron jobs, intervals, and timeouts. */
    | 'cron-schedule';

/**
 * Exhaustiveness-gate pattern for NodeKind.
 * Using `Record<NodeKind, null>` forces a compile error when a new NodeKind
 * variant is added but not listed here. Callers use `NODE_KIND_VALUES` for
 * runtime validation (e.g. CLI --kinds flag, MCP input schema).
 */
const NODE_KIND_CHECK: Record<NodeKind, null> = {
    'service': null,
    'lib': null,
    'nats-subject': null,
    'db-table': null,
    'queue': null,
    'module': null,
    'provider': null,
    'file': null,
    'external': null,
    'fe-page': null,
    'fe-component': null,
    'fe-route': null,
    'fe-hook': null,
    'endpoint': null,
    'config-field': null,
    'scoped-marker': null,
    'db-entity-field': null,
    'doc-section': null,
    'cron-schedule': null,
};

/** All valid NodeKind values — used for runtime validation and zod enum schemas. */
export const NODE_KIND_VALUES = Object.keys(NODE_KIND_CHECK) as [NodeKind, ...NodeKind[]];

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
    | 'lib-usage'
    | 'fe-imports'
    | 'fe-renders'
    | 'fe-routes-to'
    | 'endpoint-of'
    | 'endpoint-calls'
    | 'config-read-by'
    | 'entity-has-field'
    /** STUB: reserved for forward-compat — no scoped edges emitted in v1; see B8 in design doc */
    | 'scoped'
    /** @nestjs/schedule cron-schedule triggers an owner service/lib. */
    | 'cron-triggers';

export interface GraphNode {
    id: string;
    kind: NodeKind;
    label: string;
    path?: string;
    /**
     * Optional anchor into the source file for kinds where the label is not the
     * declaration name (e.g. `endpoint` labels are `"POST /path"`, but the anchor
     * is `"ControllerClass.methodName"`; `db-entity-field` labels are `"table/col"`,
     * anchor is `"EntityClass.propertyName"`).
     *
     * Format: flat string — either a bare name or "ClassName.memberName".
     */
    anchor?: Anchor;
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
 * The discriminated union encodes three resolution outcomes:
 *   - `resolved`:    type-factory arg parsed + target class indexed as `@Entity`
 *   - `not-indexed`: type-factory arg parsed but target class NOT in entity index
 *   - `unparseable`: type-factory arg could not be parsed (dynamic expression, etc.)
 *
 * The co-invariant `resolvedTarget !== null → targetClass !== ''` is now
 * structural — the type system prevents the two fields from drifting apart.
 */
export type TypeOrmRelation = {
    /** Decorator name as written. */
    decorator: 'ManyToOne' | 'OneToMany' | 'ManyToMany' | 'OneToOne';
    /** Class that owns the property bearing the relation decorator. */
    ownerClass: string;
    /** Property name on the owner class. */
    propertyName: string;
    location: SourceLoc;
} & (
    | {
          /** Parsed + indexed: `() => Foo` resolved to a known `@Entity`. */
          targetClass: string;
          resolvedTarget: TypeOrmEntity;
          reason?: never;
          raw?: never;
      }
    | {
          /** Parsed but target class not in entity index (external / missing). */
          targetClass: string;
          resolvedTarget: null;
          reason: 'not-indexed';
          raw?: never;
      }
    | {
          /** Could not parse the decorator argument (dynamic expression, etc.). */
          targetClass: null;
          resolvedTarget: null;
          reason: 'unparseable';
          /** Original source text of the first decorator argument, for diagnostics. */
          raw: string;
      }
);

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
     * Relations that could not be fully resolved: either the type-factory argument
     * could not be parsed (`reason: 'unparseable'`) or the parsed class name was not
     * found in the entity index (`reason: 'not-indexed'`). Each entry carries a
     * structured `reason` field for downstream diagnostics.
     */
    unresolvedRelations: TypeOrmRelation[];
    counts: {
        resolved: number;
        unresolvedEntity: number;
        unowned: number;
        entityDecoratorWarnings: number;
        /** Number of `db-relation` edges emitted (after dedup + Policy A `@OneToMany` skip). */
        relationsEmitted: number;
        /**
         * Number of input relations where `resolvedTarget !== null`, counted BEFORE
         * Policy A `@OneToMany` filtering. A `@OneToMany` with a resolved target is
         * included in this count even though it never produces an edge.
         */
        relationsResolved: number;
        unresolvedRelations: number;
        /**
         * Number of `@OneToMany` relations skipped under Policy A (FK lives on the
         * `@ManyToOne` side; emitting both would produce duplicate reverse edges).
         * Surfaced in the pipeline log for observability.
         */
        oneToManySkipped: number;
        /**
         * Breakdown of unresolved relations by reason.
         *   `unparseable`     — decorator argument could not be parsed (dynamic expression, etc.)
         *   `notIndexed`      — parsed target class name not found in entity index
         *   `ownerNotIndexed` — resolvedTarget is non-null but the ownerClass was not found in
         *                       entityIndex (defensive branch; should be unreachable in a well-formed
         *                       run, but is now tracked structurally so the invariant is maintained)
         *
         * Invariant: `unparseable + notIndexed + ownerNotIndexed === unresolvedRelations`
         * (Policy A — @OneToMany — is filtered before unresolved bucketing; unresolved
         * @OneToMany relations are NOT counted here.)
         */
        unresolvedReasons: {
            unparseable: number;
            notIndexed: number;
            /** Defensive counter: ownerClass absent from entityIndex despite resolvedTarget being set. */
            ownerNotIndexed: number;
        };
        /**
         * Number of times the cycle-guard in `getAllProperties` was triggered: a
         * circular base-class chain was detected and truncated. TypeScript's type
         * system forbids actual cyclic extension, but ts-morph on a partial/malformed
         * AST can return unexpected `getBaseClass()` results. Surfaced here so callers
         * reading diagnostics are not blind to the stderr-only signal.
         */
        baseClassCycles: number;
    };
}

/**
 * Diagnostics for the Variant 2 endpoint domain.
 * Merges extractor-level (non-literal arg) and mapper-level (unowned file) messages.
 */
export interface EndpointDiagnostics {
    /** Combined extractor + mapper diagnostics. file/line are optional (mapper messages carry no location). */
    messages: Array<{ message: string; file?: string; line?: number }>;
}

/**
 * Diagnostics produced by the OpenAPI YAML enrichment pass.
 * Reported in `DiagnosticsReport.openapi` and in the `diagnostics.json` output.
 */
export interface OpenApiDiagnostics {
    /** Number of YAML files successfully parsed (excludes files that produced parse errors). */
    filesProcessed: number;
    /** Number of endpoint graph nodes that were successfully enriched. */
    endpointsMatched: number;
    /**
     * YAML operations that had no matching endpoint graph node.
     * The caller can use this to detect YAML drift from the actual codebase.
     */
    endpointsUnmatched: Array<{
        /** `operationId` from the YAML operation, if present. */
        operationId?: string;
        /** HTTP method (lowercase) from the YAML path item. */
        method: string;
        /** Path string from the YAML `paths` object. */
        path: string;
    }>;
    /** YAML files that could not be parsed. Other files continue to be processed. */
    parseErrors: Array<{ file: string; error: string }>;
}

/**
 * Diagnostics for the Variant 2 config-field domain.
 * Merges extractor-level (non-literal key) and mapper-level (unowned file) messages.
 */
export interface ConfigDiagnostics {
    /** Combined extractor + mapper diagnostics. file/line are optional (mapper messages carry no location). */
    messages: Array<{ message: string; file?: string; line?: number }>;
}

/**
 * Diagnostics for the Variant 2 db-entity-field domain.
 * Merges extractor-level (not-in-index) and mapper-level (duplicate fields) messages.
 */
export interface DbEntityFieldsDiagnostics {
    /** Combined extractor + mapper diagnostics. file/line are optional (mapper messages carry no location). */
    messages: Array<{ message: string; file?: string; line?: number }>;
    counts: {
        /**
         * Number of circular base-class chains detected and truncated by the cycle guard
         * in `getAllFieldProperties`. Mirrors `TypeOrmDiagnostics.counts.baseClassCycles`
         * so consumers are not blind to the stderr-only signal when entity fields are
         * extracted via the base-class chain walk.
         */
        baseClassCycles: number;
    };
}

/**
 * Diagnostics for the Variant 2 scoped-marker domain (stub).
 */
export interface ScopedDiagnostics {
    /** Number of scoped-marker sites found (0 in v1 stub). */
    markerCount: number;
    /** Extractor-level messages. */
    messages: Array<{ file: string; line: number; message: string }>;
}

// ============================================================================
// Docs-domain types (v1 — nodes only, no edges)
// ============================================================================

export type DocsSkipReason =
    | 'oversized'
    | 'non-utf8'
    | 'empty'
    | 'gitignored'
    | 'read-error';

export interface DocsDiagnostics {
    filesScanned: number;
    filesSkipped: Array<{ path: string; reason: DocsSkipReason }>;
    frontmatterErrors: Array<{ path: string; error: string }>;
    oversizedChunks: Array<{ docSectionId: string; tokenCount: number }>;
    counts: {
        filesIncluded: number;
        nodesEmitted: number;
        headingsTotal: number;
        sectionsSplit: number;
        filesWithFrontmatter: number;
    };
}

export interface DocsValidationReport {
    summary: {
        filesIncluded: number;
        filesProcessed: number;
        filesSkippedWithReason: number;
        recall: number;
        meetsFloor: boolean;
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
    fe: import('../mapper/fe-to-graph.js').FeDiagnostics;
    cycles: CyclesDiagnostics;
    /** Variant 2 — endpoint domain diagnostics. */
    endpoint?: EndpointDiagnostics;
    /** Variant 2 — config-field domain diagnostics. */
    config?: ConfigDiagnostics;
    /** Variant 2 — db-entity-field domain diagnostics. */
    dbEntityFields?: DbEntityFieldsDiagnostics;
    /** Variant 2 — scoped-marker domain diagnostics (stub). */
    scoped?: ScopedDiagnostics;
    /** Docs-domain diagnostics. */
    docs?: DocsDiagnostics;
    /** OpenAPI YAML enrichment diagnostics — populated by the enrichment pass in `runBuild`. */
    openapi?: OpenApiDiagnostics;
    /** Cron-schedule domain diagnostics (mapper-level: unowned sites + category counts). */
    cron?: CronScheduleDiagnostics;
    /**
     * Populated only when `arch-graph semantic build` has been run.
     * Optional so plain `arch-graph build` keeps the same diagnostics.json
     * shape without breaking existing consumers.
     */
    semantic?: import('../semantic/types.js').SemanticDiagnostics;
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
    /**
     * Set when cycle detection degraded or failed. A `RangeError` (stack overflow on
     * a very large graph) populates this field and leaves `cycles: []`; the build
     * continues. Any other unexpected error causes a hard re-throw instead.
     *
     * Consumers can check `if (diagnostics.cycles.error)` to detect degraded-mode runs.
     */
    error?: string;
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

/**
 * A single ground-truth entry from the db-entity-field validator regex scan.
 * Named here so `DbEntityFieldsValidationResult.groundTruth` has a concrete type
 * (avoids anonymous inline object — mirrors `TypeOrmGroundTruthEntry` pattern).
 */
export interface DbEntityFieldGroundTruthEntry {
    file: string;
    line: number;
    matchedText: string;
    decorator: string;
}

/**
 * Validation result for the Variant 2 db-entity-field domain.
 * Mirrors `EndpointValidationResult` / `ConfigValidationResult` shape.
 */
export interface DbEntityFieldsValidationResult {
    /** Ground-truth entries found by `@Column*` decorator regex. */
    groundTruth: DbEntityFieldGroundTruthEntry[];
    /** Number of detected column decorator occurrences via ground-truth regex. */
    groundTruthCount: number;
    /** Recall: groundTruth > 0 ? extracted / groundTruth : null. */
    recall: number | null;
    /** Recall floor 95%. True if recall >= 0.95 or no ground truth detected. */
    meetsFloor: boolean;
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
    fe: import('../validation/fe-validator.js').FeValidationReport;
    /** Variant 2 — endpoint validation report. */
    endpoint?: import('../validation/endpoint-validator.js').EndpointValidationResult;
    /** Variant 2 — config-field validation report. */
    config?: import('../validation/config-validator.js').ConfigValidationResult;
    /** Variant 2 — db-entity-field validation report. */
    dbEntityFields?: DbEntityFieldsValidationResult;
    /** Docs-domain validation report. */
    docs?: DocsValidationReport;
    /** Cron-schedule domain validation report. */
    cron?: import('../validation/cron-schedule-validator.js').CronScheduleValidationReport;
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
// Cron-schedule-domain types (@nestjs/schedule)
// ============================================================================

/**
 * Mapper-level diagnostics for the cron-schedule domain.
 * Mirrors `BullMqDiagnostics` shape — unowned sites + category counts.
 */
export interface CronScheduleDiagnostics {
    /** Sites whose file falls outside apps/ and libs/ (no owner found). */
    unowned: CronScheduleSite[];
    counts: {
        totalSites: number;
        cron: number;
        interval: number;
        timeout: number;
        dynamic: number;
        unowned: number;
        nodesEmitted: number;
        edgesEmitted: number;
    };
}

/**
 * One cron/interval/timeout site found in source.
 *
 *   - `cron`     — `@Cron(expression)` decorator on a class method
 *   - `interval` — `@Interval(ms)` decorator on a class method
 *   - `timeout`  — `@Timeout(ms)` decorator on a class method
 *   - `dynamic`  — `SchedulerRegistry.addCronJob/addInterval/addTimeout(...)` call
 */
export interface CronScheduleSite {
    /** "ClassName.methodName" for decorator sites; "dynamic:<name>" for registry sites. */
    owner: string;
    /** Optional job/interval/timeout name from options arg or first string arg. */
    name?: string;
    /** Raw first argument text (string literal value or identifier text or ms as string). */
    expression: string;
    /** Resolved cron string (for CronExpression.X enum lookups) or undefined if unresolvable. */
    resolvedExpression?: string;
    /** Human-readable label for well-known CronExpression aliases; undefined for custom expressions. */
    humanReadable?: string;
    category: 'cron' | 'interval' | 'timeout' | 'dynamic';
    location: SourceLoc;
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
     * Also includes refs where the enclosing class or target class is not registered
     * in providerNodes (reason: 'target-not-in-di-graph' or 'source-not-in-di-graph').
     *
     * Capped at 200 entries. Check `unresolvedFilterRefsTruncated` for overflow.
     */
    unresolvedFilterRefs: DiFilterChainRef[];
    /**
     * True when `unresolvedFilterRefs` reached the 200-entry cap and additional
     * entries were discarded.
     */
    unresolvedFilterRefsTruncated: boolean;
    /**
     * Source files that were skipped during filter-chain extraction because they
     * contained only anonymous / default-export classes with no getName().
     */
    skippedAnonymousFiles: string[];
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
        /**
         * Number of filter-chain refs that were dropped by the dedup key.
         * Allows consumers to verify:
         *   guards + interceptors + pipes + unresolvedFilterRefs.length + dedupDropped + truncatedFilterRefs === filterChain.length
         */
        dedupDropped: number;
        /**
         * Filter-chain refs that exceeded the 200-cap in unresolvedFilterRefs and were not retained.
         */
        truncatedFilterRefs: number;
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
 *                     `static`       → `TsStaticResolution`  (no `dynamic-non-literal`)
 *                     `dynamic`      → `TsDynamicResolution`  (all five variants including `dynamic-non-literal`)
 *                     `cjs-require`  → `TsDynamicResolution`  (same as `dynamic`; non-literal `require(varName)` produces `dynamic-non-literal`)
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
