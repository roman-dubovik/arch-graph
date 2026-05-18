/**
 * OpenAPI YAML enrichment pass — Option 1.
 *
 * Finds YAML files matching configured globs in the project root, parses them
 * via js-yaml, and injects `meta.openapiInfo` into matching endpoint nodes.
 *
 * Matching strategy (operationId-first, path/method fallback):
 *   1. Primary: `operationId === node.meta.methodName`
 *   2. Fallback: `(yamlMethod, yamlPath)` vs parsed `node.label`
 *
 * No throw on parse errors or unmatched entries — all failures are recorded
 * in the returned diagnostics.
 */

import { readFile } from 'node:fs/promises';
import fastGlob from 'fast-glob';
import yaml from 'js-yaml';

import type { GraphNode } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenApiInfo {
    description?: string;
    summary?: string;
    tags?: string[];
    paramSummary?: string;
}

export interface OpenApiEnrichDiagnostics {
    filesProcessed: number;
    endpointsMatched: number;
    endpointsUnmatched: Array<{ operationId?: string; method: string; path: string }>;
    parseErrors: Array<{ file: string; error: string }>;
    /** operationIds that matched more than one endpoint node (all candidates are enriched). */
    ambiguousOperationIds: Array<{ operationId: string; candidates: string[] }>;
}

export interface OpenApiEnrichResult {
    diagnostics: OpenApiEnrichDiagnostics;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_OPENAPI_GLOBS: readonly string[] = [
    'api/*.yaml',
    'api/*.yml',
    '**/openapi.yaml',
    '**/swagger.yaml',
];

// ---------------------------------------------------------------------------
// Internal types for parsed YAML structure
// ---------------------------------------------------------------------------

interface OpenApiOperation {
    operationId?: unknown;
    summary?: unknown;
    description?: unknown;
    tags?: unknown;
    parameters?: unknown;
}

interface OpenApiPaths {
    [path: string]: {
        [method: string]: OpenApiOperation;
    } | undefined;
}

interface OpenApiDocument {
    paths?: OpenApiPaths;
}

// HTTP methods that appear as keys in OpenAPI paths
const OPENAPI_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Enrich endpoint nodes with OpenAPI metadata.
 *
 * @param nodes        All graph nodes (only `kind === 'endpoint'` are considered).
 * @param projectRoot  Absolute path to the project root; globs are resolved relative to it.
 * @param openapiGlobs Glob patterns (relative to projectRoot). Defaults to DEFAULT_OPENAPI_GLOBS.
 * @returns            Diagnostics describing what was matched, unmatched, or errored.
 */
export async function enrichEndpointsFromOpenApi(
    nodes: GraphNode[],
    projectRoot: string,
    openapiGlobs?: string[],
): Promise<OpenApiEnrichResult> {
    const globs = openapiGlobs ?? [...DEFAULT_OPENAPI_GLOBS];

    const diagnostics: OpenApiEnrichDiagnostics = {
        filesProcessed: 0,
        endpointsMatched: 0,
        endpointsUnmatched: [],
        parseErrors: [],
        ambiguousOperationIds: [],
    };

    // Track which node IDs have been enriched so duplicate YAML files don't
    // inflate endpointsMatched (P2-B).
    const matchedNodeIds = new Set<string>();
    // Accumulate ambiguous operationId candidates across all YAML files (P2-C).
    const ambiguityMap = new Map<string, string[]>();

    // Discover YAML files
    const files = await fastGlob(globs, {
        cwd: projectRoot,
        absolute: true,
        onlyFiles: true,
    });

    if (files.length === 0) {
        return { diagnostics };
    }

    // Build lookup index over endpoint nodes for efficient matching
    const endpointNodes = nodes.filter((n) => n.kind === 'endpoint');
    // Index by methodName → node[] (for operationId-first match; P2-C: multiple nodes can share methodName)
    const byMethodName = new Map<string, GraphNode[]>();
    // Index by "METHOD /path" (lowercase method, params normalised to :x) → node (for fallback match)
    const byMethodPath = new Map<string, GraphNode>();

    /** Normalise OpenAPI `{param}` placeholders to NestJS `:param` form. */
    function normalisePath(p: string): string {
        return p.replace(/\{([^}]+)\}/g, ':$1');
    }

    for (const node of endpointNodes) {
        const methodName = node.meta?.methodName;
        if (typeof methodName === 'string' && methodName) {
            const existing = byMethodName.get(methodName);
            if (existing) {
                existing.push(node);
            } else {
                byMethodName.set(methodName, [node]);
            }
        }
        // label format: "GET /users/:id" — normalise path side to :x form
        const label = node.label;
        if (label) {
            const spaceIdx = label.indexOf(' ');
            if (spaceIdx > 0) {
                const method = label.slice(0, spaceIdx).toLowerCase();
                const path = normalisePath(label.slice(spaceIdx + 1));
                byMethodPath.set(`${method}:${path}`, node);
            }
        }
    }

    // Process each YAML file
    for (const filePath of files) {
        let raw: string;
        try {
            raw = await readFile(filePath, 'utf8');
        } catch (err) {
            diagnostics.parseErrors.push({
                file: filePath,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        let doc: OpenApiDocument;
        try {
            const parsed = yaml.load(raw);
            if (!parsed || typeof parsed !== 'object') {
                // Valid YAML but not an object — nothing to enrich
                diagnostics.filesProcessed++;
                continue;
            }
            doc = parsed as OpenApiDocument;
        } catch (err) {
            diagnostics.parseErrors.push({
                file: filePath,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        diagnostics.filesProcessed++;

        const paths = doc.paths;
        if (!paths || typeof paths !== 'object') {
            continue;
        }

        // Iterate all path/method combinations
        for (const [apiPath, pathItem] of Object.entries(paths)) {
            if (!pathItem || typeof pathItem !== 'object') continue;

            for (const [methodKey, operation] of Object.entries(pathItem)) {
                if (!OPENAPI_HTTP_METHODS.has(methodKey.toLowerCase())) continue;
                if (!operation || typeof operation !== 'object') continue;

                const op = operation as OpenApiOperation;
                const operationId = typeof op.operationId === 'string' ? op.operationId : undefined;
                const yamlMethod = methodKey.toLowerCase();

                // --- Primary match: operationId === methodName ---
                let matchedNodes: GraphNode[] = [];
                if (operationId) {
                    matchedNodes = byMethodName.get(operationId) ?? [];
                }

                // --- Fallback match: (method, normalised path) ---
                if (matchedNodes.length === 0) {
                    const normPath = normalisePath(apiPath);
                    const fallback = byMethodPath.get(`${yamlMethod}:${normPath}`);
                    if (fallback) {
                        matchedNodes = [fallback];
                    }
                }

                if (matchedNodes.length === 0) {
                    diagnostics.endpointsUnmatched.push({
                        operationId,
                        method: yamlMethod,
                        path: apiPath,
                    });
                    continue;
                }

                // Record ambiguity when multiple nodes share the same operationId (P2-C)
                if (operationId && matchedNodes.length > 1) {
                    const candidateIds = matchedNodes.map((n) => n.id);
                    const existing = ambiguityMap.get(operationId);
                    if (!existing) {
                        ambiguityMap.set(operationId, candidateIds);
                    }
                }

                // Build openapiInfo
                const info: OpenApiInfo = {};

                if (typeof op.description === 'string' && op.description) {
                    info.description = op.description;
                }
                if (typeof op.summary === 'string' && op.summary) {
                    info.summary = op.summary;
                }
                if (Array.isArray(op.tags) && op.tags.length > 0) {
                    info.tags = op.tags.filter((t): t is string => typeof t === 'string');
                }

                // Build paramSummary from parameters array
                if (Array.isArray(op.parameters)) {
                    const parts: string[] = [];
                    for (const param of op.parameters) {
                        if (!param || typeof param !== 'object') continue;
                        const p = param as Record<string, unknown>;
                        const name = typeof p['name'] === 'string' ? p['name'] : undefined;
                        const desc = typeof p['description'] === 'string' ? p['description'] : undefined;
                        if (name && desc) {
                            parts.push(`${name}: ${desc}`);
                        } else if (name) {
                            // Include names without descriptions too — still useful for embedding
                            parts.push(name);
                        }
                    }
                    if (parts.length > 0) {
                        info.paramSummary = parts.join('; ');
                    }
                }

                // Mutate all matched nodes in-place; track unique enriched IDs (P2-B)
                for (const matchedNode of matchedNodes) {
                    matchedNode.meta = { ...(matchedNode.meta ?? {}), openapiInfo: info };
                    matchedNodeIds.add(matchedNode.id);
                }
            }
        }
    }

    // Compute final counters from sets (P2-B: deduped count)
    diagnostics.endpointsMatched = matchedNodeIds.size;
    // Flush ambiguity map to diagnostics (P2-C)
    for (const [operationId, candidates] of ambiguityMap) {
        diagnostics.ambiguousOperationIds.push({ operationId, candidates });
    }

    return { diagnostics };
}
