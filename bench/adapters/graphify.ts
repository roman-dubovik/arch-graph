// Adapter: graphify graph.json → compact LLM context.
//
// graphify emits a NetworkX node-link format (directed=False, multigraph=False)
// with nodes carrying {id, label, file_type, source_file, source_location,
// community, norm_label, ...} and links {source, target, relation, confidence,
// confidence_score, source_file, source_location, weight, ...}. We compress
// using the same aggressive strategy as the arch-graph adapter (drop
// confidence scores, weights, source_location, community attribution) so the
// two token counts are directly comparable. We also drop NetworkX-internal
// fields (`_src`/`_tgt`, `directed`, `multigraph`).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

interface GraphifyNode {
    id: string;
    label?: string;
    file_type?: string;
    source_file?: string;
    source_location?: string;
    community?: number;
    norm_label?: string;
}

interface GraphifyLink {
    source: string;
    target: string;
    relation?: string;
    confidence?: string;
    confidence_score?: number;
    source_file?: string;
    source_location?: string;
    weight?: number;
    _src?: string;
    _tgt?: string;
}

interface GraphifyGraph {
    directed: boolean;
    multigraph: boolean;
    graph?: Record<string, unknown>;
    nodes: GraphifyNode[];
    links: GraphifyLink[];
    hyperedges?: unknown[];
}

export interface CompactGraph {
    schema: string;
    nodes: Array<{ id: string; k: string; label?: string }>;
    edges: Array<{ f: string; t: string; k: string; at?: string }>;
}

export async function loadGraphifyGraph(path: string): Promise<GraphifyGraph> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as GraphifyGraph;
}

/** Strip graphify's graph to the same shape as the arch-graph compact form. */
export function compactGraphifyGraph(g: GraphifyGraph): CompactGraph {
    const nodes = g.nodes.map((n) => {
        const out: { id: string; k: string; label?: string } = {
            id: n.id,
            k: n.file_type ?? 'unknown',
        };
        if (n.label && n.label !== n.id) out.label = n.label;
        return out;
    });

    const edges = g.links.map((e) => {
        const out: { f: string; t: string; k: string; at?: string } = {
            f: e.source,
            t: e.target,
            k: e.relation ?? 'related',
        };
        if (e.source_file && e.source_location) {
            out.at = `${basename(e.source_file)}:${e.source_location}`;
        }
        return out;
    });

    return {
        schema:
            'graphify compact: nodes {id,k=file_type,label?}, edges {f=source,t=target,k=relation,at?=file:loc}. ' +
            'Node ids are lowercase_with_underscores; labels carry human-readable names. ' +
            'Edge kinds (relations) are graphify-defined: imports_from, calls, references, ' +
            'conceptually_related_to, semantically_similar_to, etc.',
        nodes,
        edges,
    };
}

export function serializeContext(g: CompactGraph): string {
    return `# graphify context\n${g.schema}\n\n${JSON.stringify({ nodes: g.nodes, edges: g.edges })}`;
}

/**
 * Discover the graphify-out/graph.json for a given project root.
 * Returns null if graphify hasn't been run on that project.
 *
 * We look in two places, in order:
 *   1. `<project-root>/graphify-out/graph.json` — the canonical location
 *      where `/graphify <path>` writes its output.
 *   2. `bench/cache/<project-id>/graphify-out/graph.json` — a benchmark
 *      cache (so users can stash a pre-built graphify graph alongside
 *      this repo without polluting the project being analyzed).
 */
export function findGraphifyOutput(
    projectId: string,
    projectRoot: string,
    benchCacheRoot: string,
): string | null {
    const cands = [
        `${projectRoot}/graphify-out/graph.json`,
        `${benchCacheRoot}/${projectId}/graphify-out/graph.json`,
    ];
    for (const c of cands) {
        if (existsSync(c)) return c;
    }
    return null;
}
