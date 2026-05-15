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
    | 'file';

export type EdgeKind =
    | EdgeKindNats
    | 'http-call'
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
    imports: ImportsDiagnostics;
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
// TS-imports domain types
// ============================================================================

/**
 * One `import` declaration captured during the imports extractor walk.
 *
 *  - `specifier`        — raw module specifier text (e.g. `"@platform/messaging"`).
 *  - `resolvedFilePath` — absolute path of the file the specifier resolved to.
 *                          `null` means external (node_modules) or unresolvable
 *                          (broken alias / typo). Either way, no graph edge.
 *  - `kind`             — discriminates static `import ...` vs dynamic `import(...)`.
 *                          Dynamic imports are captured for diagnostics but never
 *                          gate the recall metric (the regex GT only sees static).
 *  - `typeOnly`         — `import type { X } from ...`. Still produces graph edges:
 *                          a type-only dep is still a structural lib usage.
 */
export interface TsImportSite {
    sourceFile: string;
    specifier: string;
    resolvedFilePath: string | null;
    kind: 'static' | 'dynamic';
    typeOnly: boolean;
    /**
     * `true` when the specifier matched a tsconfig-`paths` alias prefix at
     * resolution time. Distinguishes "this looks internal" (`@platform/x`)
     * from "this is bare external" (`react`). Set even when resolution
     * succeeds — used by the mapper to route resolution failures correctly.
     */
    specifierShape: 'relative' | 'alias' | 'bare-external' | 'builtin';
    location: SourceLoc;
}

export interface ImportsDiagnostics {
    /**
     * Static imports whose specifier didn't resolve to a real file AND wasn't a
     * bare external (`@foo/bar` / `node:fs` / no slashes). These are the suspicious
     * ones — usually a typo'd path alias or a missing `paths` entry in tsconfig.
     */
    unresolvedImports: TsImportSite[];
    /** Dynamic `import(...)` calls — kept for visibility, not gated. */
    dynamicImports: TsImportSite[];
    counts: {
        totalStatic: number;
        totalDynamic: number;
        resolvedToOwner: number;
        externalOrUnresolved: number;
        unresolvedInternal: number;
    };
}

export interface ImportsGroundTruthEntry {
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
