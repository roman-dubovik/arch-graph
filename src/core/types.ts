// ============================================================================
// Source locations
// ============================================================================

export interface SourceLoc {
    file: string;
    line: number;
    column: number;
}

// ============================================================================
// NATS-domain types (carried over from POC — validated on 5 projects)
// ============================================================================

export type EdgeKindNats = 'nats-publish' | 'nats-request' | 'nats-subscribe' | 'nats-reply';

export type ResolvedSubject =
    | { kind: 'literal'; value: string }
    | { kind: 'pattern'; pattern: string; placeholders: string[] }
    | { kind: 'dynamic'; hint: string }
    | { kind: 'unresolved'; raw: string; reason: string };

export interface NatsCallSite {
    role: 'sender' | 'receiver';
    edgeKind: EdgeKindNats;
    subject: ResolvedSubject;
    location: SourceLoc;
    via: string;
    enclosingClass?: string;
}

export interface WrapperApi {
    class: string;
    methods: string[];
}

// ============================================================================
// Common graph schema (01-roadmap + 02-extractors-design)
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
    /** Resolved table name: explicit decorator arg, schema.name field, or snake_case(className). */
    table: string;
    /** True when no explicit `@Entity('name')` — name fell back to snake_case heuristic. */
    inferredTable: boolean;
    file: string;
    line: number;
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

export interface TypeOrmEntityDecoratorWarning {
    className: string;
    file: string;
    line: number;
    reason: 'object-literal-missing-name' | 'non-static-argument';
    argKind?: string;
}

export interface TypeOrmDiagnostics {
    /** `@InjectRepository(X)` where X isn't a known `@Entity` (likely external or non-entity). */
    unresolvedEntities: TypeOrmInjectionSite[];
    /** Injection sites outside apps/ and libs/. */
    unowned: TypeOrmInjectionSite[];
    /** `@Entity(...)` decorators that fell back to snake_case or couldn't be indexed at all. */
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
}

// ============================================================================
// Validation (carried over from POC, extended for TypeORM)
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
}
