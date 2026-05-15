// Adapter: arch-graph graph.json → compact LLM context.
//
// arch-graph emits a typed nodes/edges graph (NestJS-specific). The compressor
// strips redundant fields the LLM doesn't need to *answer* an architecture
// question:
//   - drop absolute file paths (keep basename when useful)
//   - drop `meta`, `buildAt`, `root`, `version`
//   - drop edge IDs (the id is just a deterministic concat of from/to/file/line —
//     redundant given we keep from/to)
//
// We keep node `id` + `kind` + `label`; edges keep `from`/`to`/`kind` plus a
// short `at` for edges that have a code location (line is useful, full path is
// not — we keep the basename).

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

interface ArchNode {
    id: string;
    kind: string;
    label?: string;
    path?: string;
    meta?: Record<string, unknown>;
}

interface ArchEdge {
    id?: string;
    from: string;
    to: string;
    kind: string;
    file?: string;
    line?: number;
    meta?: Record<string, unknown>;
    dynamic?: boolean;
    subjectPattern?: string;
}

interface ArchGraph {
    nodes: ArchNode[];
    edges: ArchEdge[];
}

export interface CompactGraph {
    /** A short human-readable note explaining the schema to the LLM. */
    schema: string;
    nodes: Array<{ id: string; k: string; label?: string }>;
    edges: Array<{ f: string; t: string; k: string; at?: string }>;
}

export async function loadArchGraph(path: string): Promise<ArchGraph> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as ArchGraph;
}

/** Strip a graph down to its minimal LLM-context form. */
export function compactArchGraph(g: ArchGraph): CompactGraph {
    const nodes = g.nodes.map((n) => {
        const out: { id: string; k: string; label?: string } = {
            id: n.id,
            k: n.kind,
        };
        if (n.label && n.label !== n.id) out.label = n.label;
        return out;
    });

    const edges = g.edges.map((e) => {
        const out: { f: string; t: string; k: string; at?: string } = {
            f: e.from,
            t: e.to,
            k: e.kind,
        };
        if (e.file && e.line) out.at = `${basename(e.file)}:${e.line}`;
        return out;
    });

    return {
        schema:
            'arch-graph compact: nodes {id,k=kind,label?}, edges {f=from,t=to,k=kind,at?=file:line}. ' +
            'node kinds: service, lib, module, provider, db-table, nats-subject, queue, external. ' +
            'edge kinds: nats-publish/subscribe/request/reply, queue-produce/consume, db-access, ' +
            'di-import/provides/exports/controller, http-call/external, lib-usage, ts-import.',
        nodes,
        edges,
    };
}

/** Serialize as compact JSON (no pretty-printing — fewer tokens). */
export function serializeContext(g: CompactGraph): string {
    // Plain JSON.stringify keeps it deterministic. We prepend the schema as a
    // free-form comment-style header so the LLM can read it.
    return `# arch-graph context\n${g.schema}\n\n${JSON.stringify({ nodes: g.nodes, edges: g.edges })}`;
}
