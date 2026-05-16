import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ArchGraph, EdgeKind, GraphEdge, GraphNode, NodeKind } from '../core/types.js';

// ============================================================================
// Collision reporting
// ============================================================================

/**
 * One entry in `mermaid-collisions.json` — groups all raw node ids that
 * collapsed to the same sanitized base id, along with the node kind of the
 * first collider (which keeps the plain base; subsequent colliders receive
 * `_2`, `_3`, … suffixes).
 */
export interface CollisionGroup {
    sanitizedId: string;
    originalIds: string[];
    nodeKind: NodeKind;
}

/** Shape of `mermaid-collisions.json`. */
interface CollisionsFile {
    collisions: CollisionGroup[];
    generatedAt: string;
}

// ============================================================================
// Public API
// ============================================================================

export type MermaidSliceMode =
    | { kind: 'full' }
    | { kind: 'per-service' }
    | { kind: 'domain'; domain: DomainKey };

export type DomainKey = 'nats' | 'bullmq' | 'typeorm' | 'http' | 'di' | 'ts-import' | 'lib';

export interface MermaidWriteOptions {
    /** Slicing mode. Defaults to `{ kind: 'full' }`. */
    slice?: MermaidSliceMode;
    /**
     * Threshold above which a "graph is large" header comment is emitted.
     * Mermaid Live renders ~500 nodes; we warn early at 200. Default: 200.
     */
    largeGraphThreshold?: number;
}

/**
 * Write a Mermaid flowchart for `graph` to `outPath`.
 *
 * Behaviour by `slice`:
 *   - `{ kind: 'full' }` (default): write the entire graph to `outPath`.
 *   - `{ kind: 'per-service' }`: `outPath` is treated as a DIRECTORY; one file
 *     `service-<id>.mermaid` per service is written, containing only nodes and
 *     edges touching that service.
 *   - `{ kind: 'domain', domain: 'nats' }`: write only edges whose kind belongs
 *     to that domain (plus their endpoint nodes).
 *
 * Returns the list of files actually written.
 */
export async function writeGraphMermaid(
    graph: ArchGraph,
    outPath: string,
    options: MermaidWriteOptions = {},
): Promise<string[]> {
    const slice = options.slice ?? { kind: 'full' };
    const threshold = options.largeGraphThreshold ?? 200;

    if (slice.kind === 'full') {
        const { body, collisionGroups } = renderMermaid(graph.nodes, graph.edges, threshold);
        await ensureDir(outPath);
        await writeFile(outPath, body, 'utf8');
        await flushCollisionsFile(dirname(outPath), collisionGroups);
        return [outPath];
    }

    if (slice.kind === 'domain') {
        const { nodes, edges } = sliceByDomain(graph, slice.domain);
        const { body } = renderMermaid(nodes, edges, threshold);
        await ensureDir(outPath);
        await writeFile(outPath, body, 'utf8');
        // Domain/per-service slices operate on a subset of the graph — only the
        // full build sees the complete node set, so the collision file belongs
        // exclusively to the full build and must not be touched here.
        return [outPath];
    }

    // per-service: outPath is a directory
    await mkdir(outPath, { recursive: true });
    const written: string[] = [];
    for (const svc of graph.nodes.filter((n) => n.kind === 'service')) {
        const { nodes, edges } = sliceByService(graph, svc.id);
        // Skip empty slices — a service with zero touching edges is uninteresting.
        if (edges.length === 0) continue;
        const { body } = renderMermaid(nodes, edges, threshold);
        const file = join(outPath, `service-${sanitizeFilename(svc.label)}.mermaid`);
        await writeFile(file, body, 'utf8');
        written.push(file);
    }
    // Per-service slices operate on subsets — the collision file is owned by the
    // full build and must not be touched here (see domain branch comment above).
    return written;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Per-NodeKind subgraph metadata. Single source of truth — adding a NodeKind
 * forces TS to populate `subgraphId`, `subgraphLabel`, and `cssClass` here
 * (instead of three parallel `Record<NodeKind, ...>` maps drifting apart).
 *
 * `order` controls render position — services first (visual anchor), DB tables
 * last (largest column on most graphs).
 */
interface NodeKindMeta {
    subgraphId: string;
    subgraphLabel: string;
    /** classDef name from CLASS_DEFS — drives node fill/stroke colour. */
    cssClass: string;
    /** Lower number = rendered earlier (left side of `flowchart LR`). */
    order: number;
}

const NODE_KIND_META: Record<NodeKind, NodeKindMeta> = {
    service: { subgraphId: 'services', subgraphLabel: 'Services', cssClass: 'service', order: 1 },
    lib: { subgraphId: 'libs', subgraphLabel: 'Libraries', cssClass: 'lib', order: 2 },
    module: { subgraphId: 'modules', subgraphLabel: 'Modules', cssClass: 'module', order: 3 },
    queue: { subgraphId: 'queues', subgraphLabel: 'Queues', cssClass: 'queue', order: 4 },
    'nats-subject': {
        subgraphId: 'nats_subjects',
        subgraphLabel: 'NATS subjects',
        cssClass: 'nats',
        order: 5,
    },
    'db-table': { subgraphId: 'db_tables', subgraphLabel: 'DB tables', cssClass: 'db', order: 6 },
    provider: { subgraphId: 'providers', subgraphLabel: 'Providers', cssClass: 'module', order: 7 },
    external: { subgraphId: 'externals', subgraphLabel: 'External hosts', cssClass: 'lib', order: 8 },
    file: { subgraphId: 'files', subgraphLabel: 'Files', cssClass: 'file', order: 9 },
};

const SUBGRAPH_ORDER: NodeKind[] = (Object.keys(NODE_KIND_META) as NodeKind[]).sort(
    (a, b) => NODE_KIND_META[a].order - NODE_KIND_META[b].order,
);

/**
 * Mermaid edge syntax per EdgeKind.
 *
 * Design choices:
 *  - sync RPC (HTTP, nats-request) — thick `==>` to stand out
 *  - async fire-and-forget (publish, queue-*) — dotted `-.->`
 *  - subscribe/reply listed for completeness — they're the from/to flipped variant
 *    and use the same arrow as the corresponding sender. The build emits exactly one
 *    edge per logical exchange, so duplicates are not a concern.
 *  - db-* — open arrowhead `--o`
 *  - DI / ts-import / lib-usage — fainter to recede visually
 */
const EDGE_SYNTAX: Record<EdgeKind, string> = {
    'nats-publish': '-.->|publish|',
    'nats-request': '==>|request|',
    'nats-subscribe': '-.->|subscribe|',
    'nats-reply': '==>|reply|',
    'http-call': '==>|http|',
    'http-external': '==>|http-ext|',
    'queue-produce': '-.->|produce|',
    'queue-consume': '-.->|consume|',
    'db-read': '--o|read|',
    'db-write': '--o|write|',
    'db-access': '--o|db|',
    'db-relation': '--o|rel|',
    // DI/import edges intentionally use the same dotted arrow as the async kinds —
    // a longer dot syntax (`-..->`) renders identically but trips some Mermaid
    // versions. Visual de-emphasis comes from the edge label, not extra dots.
    'di-import': '-.->|di|',
    'di-provides': '-.->|provides|',
    'di-exports': '-.->|exports|',
    'di-controller': '-.->|controller|',
    'di-guard': '-.->|guard|',
    'di-interceptor': '-.->|interceptor|',
    'di-pipe': '-.->|pipe|',
    'ts-import': '-.->|import|',
    'lib-usage': '-.->|lib|',
};

/**
 * Domain membership for `--mermaid-slice=domain:<key>` filtering.
 * Each EdgeKind belongs to exactly one domain.
 */
const EDGE_DOMAIN: Record<EdgeKind, DomainKey> = {
    'nats-publish': 'nats',
    'nats-request': 'nats',
    'nats-subscribe': 'nats',
    'nats-reply': 'nats',
    'http-call': 'http',
    'http-external': 'http',
    'queue-produce': 'bullmq',
    'queue-consume': 'bullmq',
    'db-read': 'typeorm',
    'db-write': 'typeorm',
    'db-access': 'typeorm',
    'db-relation': 'typeorm',
    'di-import': 'di',
    'di-provides': 'di',
    'di-exports': 'di',
    'di-controller': 'di',
    'di-guard': 'di',
    'di-interceptor': 'di',
    'di-pipe': 'di',
    'ts-import': 'ts-import',
    'lib-usage': 'lib',
};

/**
 * Mermaid node declaration with kind-appropriate shape. All class assignments
 * happen later via bulk `class id1,id2 cls;` lines — keeping declarations and
 * style binding separated makes the output easier to skim and to diff.
 */
function nodeDeclaration(node: GraphNode, idMap: Map<string, string>): string {
    const id = idMap.get(node.id) ?? sanitizeId(node.id);
    const label = escapeMermaidLabel(node.label);
    switch (node.kind) {
        case 'service':
        case 'lib':
        case 'file':
        case 'external':
            return `${id}["${label}"]`;
        case 'queue':
            return `${id}(["${label}"])`;
        case 'nats-subject':
            return `${id}(("${label}"))`;
        case 'db-table':
            return `${id}[("${label}")]`;
        case 'module':
        case 'provider':
            return `${id}{{"${label}"}}`;
    }
}

const CLASS_DEFS = [
    'classDef service fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;',
    'classDef lib fill:#ede9fe,stroke:#6d28d9,color:#4c1d95;',
    'classDef queue fill:#fef3c7,stroke:#b45309,color:#78350f;',
    'classDef nats fill:#dcfce7,stroke:#15803d,color:#14532d;',
    'classDef db fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d;',
    'classDef module fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e;',
    'classDef file fill:#f1f5f9,stroke:#475569,color:#0f172a;',
].join('\n    ');

export function renderMermaid(
    nodes: GraphNode[],
    edges: GraphEdge[],
    largeGraphThreshold: number,
): { body: string; collisionGroups: CollisionGroup[] } {
    const lines: string[] = [];

    // Per-render id map — handles `sanitizeId` collisions deterministically (first-seen wins,
    // subsequent colliders get `_<n>` suffix) and warns once when a collision occurs so the
    // operator can rename the offending raw ids. Used for every node declaration AND every
    // edge endpoint in this render — that's why it's scoped here, not at module level.
    const { map: idMap, collisionGroups } = buildIdMap(nodes);

    lines.push('flowchart LR');
    // Header comment goes INSIDE the diagram (after the directive) — some Mermaid
    // renderers require the first non-empty line to be the diagram directive.
    if (nodes.length > largeGraphThreshold) {
        lines.push(
            `    %% graph has ${nodes.length} nodes, ${edges.length} edges — consider per-service slicing`,
        );
    }

    // Empty-flowchart guard. Mermaid renders a diagram with zero nodes as an
    // error ("No nodes found"). Emit a placeholder so the file is still a valid,
    // visually unambiguous "nothing here" diagram — useful for `domain:<key>`
    // slices that filter to an empty edge-set on a project lacking that domain.
    if (nodes.length === 0) {
        lines.push('    empty["(no nodes in this slice)"]');
        lines.push('    classDef placeholder fill:#f9fafb,stroke:#9ca3af,color:#6b7280;');
        lines.push('    class empty placeholder;');
        return { body: lines.join('\n') + '\n', collisionGroups };
    }

    // Group nodes by kind, preserving deterministic SUBGRAPH_ORDER.
    const byKind = new Map<NodeKind, GraphNode[]>();
    for (const n of nodes) {
        let bucket = byKind.get(n.kind);
        if (!bucket) {
            bucket = [];
            byKind.set(n.kind, bucket);
        }
        bucket.push(n);
    }

    // Stable intra-subgraph ordering — sort by label so diffs are review-friendly.
    for (const kind of SUBGRAPH_ORDER) {
        const bucket = byKind.get(kind);
        if (!bucket || bucket.length === 0) continue;
        bucket.sort((a, b) => a.label.localeCompare(b.label));

        const meta = NODE_KIND_META[kind];
        lines.push(`    subgraph ${meta.subgraphId} [${meta.subgraphLabel}]`);
        for (const n of bucket) {
            lines.push(`        ${nodeDeclaration(n, idMap)}`);
        }
        lines.push('    end');
    }

    // Edges — also sorted for diff stability. Endpoint ids resolve through the same
    // `idMap` used for declarations, so a sanitize collision can't produce a node
    // declared under one id and referenced under another.
    const sortedEdges = [...edges].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        if (a.from !== b.from) return a.from.localeCompare(b.from);
        return a.to.localeCompare(b.to);
    });
    for (const e of sortedEdges) {
        const from = idMap.get(e.from) ?? sanitizeId(e.from);
        const to = idMap.get(e.to) ?? sanitizeId(e.to);
        lines.push(`    ${from} ${EDGE_SYNTAX[e.kind]} ${to}`);
    }

    // classDef + class assignments per node (collected after the fact for grouping).
    lines.push(`    ${CLASS_DEFS}`);
    const classBuckets = new Map<string, string[]>();
    for (const n of nodes) {
        const cls = NODE_KIND_META[n.kind].cssClass;
        let arr = classBuckets.get(cls);
        if (!arr) {
            arr = [];
            classBuckets.set(cls, arr);
        }
        arr.push(idMap.get(n.id) ?? sanitizeId(n.id));
    }
    for (const [cls, ids] of [...classBuckets.entries()].sort()) {
        // `class id1,id2 cls;` is the bulk-assign form.
        lines.push(`    class ${ids.sort().join(',')} ${cls};`);
    }

    return { body: lines.join('\n') + '\n', collisionGroups };
}

// ============================================================================
// Slicing helpers
// ============================================================================

function sliceByService(
    graph: ArchGraph,
    serviceId: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const touchingEdges = graph.edges.filter((e) => e.from === serviceId || e.to === serviceId);
    const keepIds = new Set<string>([serviceId]);
    for (const e of touchingEdges) {
        keepIds.add(e.from);
        keepIds.add(e.to);
    }
    const nodes = graph.nodes.filter((n) => keepIds.has(n.id));
    return { nodes, edges: touchingEdges };
}

function sliceByDomain(
    graph: ArchGraph,
    domain: DomainKey,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges = graph.edges.filter((e) => EDGE_DOMAIN[e.kind] === domain);
    const keepIds = new Set<string>();
    for (const e of edges) {
        keepIds.add(e.from);
        keepIds.add(e.to);
    }
    const nodes = graph.nodes.filter((n) => keepIds.has(n.id));
    return { nodes, edges };
}

// ============================================================================
// Sanitisation
// ============================================================================

/**
 * Mermaid node IDs must be ASCII identifiers (letters, digits, underscore).
 * `:`, `/`, `-`, `.` all appear in our composite ids (`service:foo`,
 * `db-table:public.users`, `lib:libs/nest-shared`). Replace them with `_`.
 *
 * Two raw ids CAN collapse to the same sanitized form when they differ only
 * in characters that all become `_` (e.g. `lib:foo-bar` vs `lib:foo.bar`).
 * `buildIdMap` resolves collisions with a `_<n>` suffix; this function is
 * still useful as the seed for that map and as a fallback for unmapped ids.
 */
function sanitizeId(rawId: string): string {
    return rawId.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Build a `rawId → sanitizedId` map that guarantees uniqueness across the node set.
 * First raw id mapping to a given sanitized form keeps the plain name; subsequent
 * colliders get a `_2`, `_3`, … suffix. Emits one stderr warning per render when
 * collisions occur — silent merge would produce a broken Mermaid diagram (two
 * declarations of the same id; edges potentially attached to the wrong node).
 *
 * Returns the id map and structured collision groups (one entry per base
 * sanitizedId that had more than one raw source), suitable for writing to
 * `mermaid-collisions.json` by the caller.
 */
function buildIdMap(nodes: GraphNode[]): { map: Map<string, string>; collisionGroups: CollisionGroup[] } {
    const map = new Map<string, string>();
    const usedSanitized = new Map<string, number>();
    // Track which raw ids (and their kinds) map to each base sanitized id.
    const baseToRaws = new Map<string, Array<{ rawId: string; kind: NodeKind }>>();

    for (const n of nodes) {
        const base = sanitizeId(n.id);
        const seen = usedSanitized.get(base) ?? 0;

        // Record first-seen mapping (needed to build the originalIds group later).
        if (!baseToRaws.has(base)) baseToRaws.set(base, []);
        baseToRaws.get(base)!.push({ rawId: n.id, kind: n.kind });

        if (seen === 0) {
            usedSanitized.set(base, 1);
            map.set(n.id, base);
            continue;
        }
        // Collision — pick the next free suffix. The loop guards against compound
        // collisions where `foo`, `foo_2`, and a third `foo`-source all coexist.
        let suffix = seen + 1;
        let candidate = `${base}_${suffix}`;
        while (usedSanitized.has(candidate)) {
            suffix++;
            candidate = `${base}_${suffix}`;
        }
        usedSanitized.set(base, suffix);
        usedSanitized.set(candidate, 1);
        map.set(n.id, candidate);
    }

    // Build structured groups for bases that had more than one raw id source.
    const collisionGroups: CollisionGroup[] = [];
    for (const [base, raws] of baseToRaws) {
        if (raws.length < 2) continue;
        collisionGroups.push({
            sanitizedId: base,
            originalIds: raws.map((r) => r.rawId),
            // Use the kind of the first node that claimed this base (the winner).
            nodeKind: raws[0]!.kind,
        });
    }

    if (collisionGroups.length > 0) {
        const sample = collisionGroups
            .slice(0, 3)
            .map((g) => `${g.originalIds.join(' vs ')} → ${g.sanitizedId}`)
            .join('; ');
        process.stderr.write(
            `[mermaid] WARNING: ${collisionGroups.length} sanitizeId collision group(s); first: ${sample}\n`,
        );
    }

    return { map, collisionGroups };
}

/**
 * Labels live inside `"..."` quotes in Mermaid. Escape the only problematic
 * characters: the quote itself and HTML entities Mermaid would otherwise parse.
 * Backslash-escape is NOT supported by Mermaid — we use the HTML entity form.
 */
function escapeMermaidLabel(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Make a filename safe for the file system (per-service slice). */
function sanitizeFilename(s: string): string {
    return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// ============================================================================
// CLI plumbing — slice-mode parsing
// ============================================================================

/**
 * Parse the `--mermaid-slice=<mode>` flag value.
 * Accepts: `full`, `per-service`, `domain:<key>`.
 * Throws on unknown input — surfaces config errors loudly rather than silently
 * downgrading to `full` (which would be a misleading no-op).
 */
export function parseSliceMode(raw: string): MermaidSliceMode {
    if (raw === 'full') return { kind: 'full' };
    if (raw === 'per-service') return { kind: 'per-service' };
    if (raw.startsWith('domain:')) {
        const key = raw.slice('domain:'.length);
        if (!isDomainKey(key)) {
            throw new Error(
                `unknown mermaid-slice domain '${key}'; valid: nats, bullmq, typeorm, http, di, ts-import, lib`,
            );
        }
        return { kind: 'domain', domain: key };
    }
    throw new Error(
        `unknown --mermaid-slice value '${raw}'; valid: full, per-service, domain:<key>`,
    );
}

function isDomainKey(s: string): s is DomainKey {
    return (
        s === 'nats' ||
        s === 'bullmq' ||
        s === 'typeorm' ||
        s === 'http' ||
        s === 'di' ||
        s === 'ts-import' ||
        s === 'lib'
    );
}

// ============================================================================
// Internals
// ============================================================================

async function ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Write `mermaid-collisions.json` into `dir` when there are collisions, or
 * delete it (best-effort) when there are none so stale artifacts from a
 * previous build don't mislead the operator.
 */
async function flushCollisionsFile(dir: string, collisionGroups: CollisionGroup[]): Promise<void> {
    const filePath = join(dir, 'mermaid-collisions.json');
    if (collisionGroups.length === 0) {
        // Remove a possibly-stale file from a prior build that did have collisions.
        await rm(filePath, { force: true });
        return;
    }
    // Ensure the directory exists — the full-build path always calls ensureDir first,
    // but defensive mkdir makes this function safe for standalone API callers too.
    await mkdir(dir, { recursive: true });
    const payload: CollisionsFile = {
        collisions: collisionGroups,
        generatedAt: new Date().toISOString(),
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

