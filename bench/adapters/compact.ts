// Shared compact-graph shape used by both bench adapters.
//
// Both arch-graph and graphify are compressed into the same {nodes, edges} shape
// so the bench runner can count tokens and score recall uniformly. The only
// per-adapter variation is the human-readable `schema` hint and the header name
// written to the context string.

export interface CompactGraph {
    /** A short human-readable note explaining the schema to the LLM. */
    schema: string;
    nodes: Array<{ id: string; k: string; label?: string }>;
    edges: Array<{ f: string; t: string; k: string; at?: string }>;
}

/** Serialize a compact graph as plain JSON with a header the LLM can read.
 *
 * `headerName` is the tool name shown in the context header, e.g. `arch-graph`
 * or `graphify`.
 */
export function serializeContext(g: CompactGraph, headerName: string): string {
    return `# ${headerName} context\n${g.schema}\n\n${JSON.stringify({ nodes: g.nodes, edges: g.edges })}`;
}

/**
 * Uniform bench-adapter contract. Both arch-graph and graphify implement this
 * so `bench/bench.ts` can drive them generically via `Map<name, BenchAdapter>`
 * — no per-tool branching in the runner.
 *
 * `load` returns `raw` typed as `unknown` because each adapter has its own
 * native schema (NetworkX node-link for graphify, typed `ArchGraph` for
 * arch-graph). The compactor narrows it back to a known shape internally.
 */
export interface BenchAdapter {
    /** Adapter name shown in logs / header (e.g. `arch-graph`, `graphify`). */
    readonly name: string;
    load(path: string): Promise<{ raw: unknown; nodeCount: number; edgeCount: number }>;
    compact(raw: unknown): CompactGraph;
    serialize(g: CompactGraph): string;
    /**
     * Resolve a graph.json path for the given project — null if the tool wasn't
     * run on it. Implementations should check canonical install locations only,
     * never invent paths.
     */
    findOutput(projectId: string, projectRoot: string, cacheRoot: string): string | null;
}
