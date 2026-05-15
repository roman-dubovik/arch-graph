import type { HttpConfig, HttpInternalService } from '../core/config.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type {
    GraphEdge,
    GraphNode,
    GraphOwnerRef,
    HttpCallSite,
    HttpDiagnostics,
    HttpTarget,
    ResolvedUrl,
} from '../core/types.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapHttpResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: HttpDiagnostics;
}

/**
 * Maps HTTP call sites to graph nodes/edges:
 *   - resolved internal target (env-ref matched, or url-pattern matched)
 *         → `http-call` edge from owner → `service:<id>`
 *   - resolved external (literal with hostname, or env-ref with no match)
 *         → `http-external` edge from owner → `external:<hostname>`
 *         (env-ref with no matching internal service is intentionally NOT graphed:
 *         we have no stable hostname for it; it's diagnostic-only.)
 *   - `pattern` URL not anchored on a resolvable base → diagnostics only
 *   - `unresolved`                                    → diagnostics only
 *   - call sites in unknown owners                    → diagnostics.unowned
 *
 * Edge cardinality: one edge per (owner, target, kind). First-seen file:line wins.
 */
export function mapHttpToGraph(
    sites: HttpCallSite[],
    ownership: OwnershipRegistry,
    httpCfg: HttpConfig | undefined,
): MapHttpResult {
    const ownerNodes = new Map<string, GraphNode>();
    const targetNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unresolved: HttpCallSite[] = [];
    const unowned: HttpCallSite[] = [];
    const externalCalls: HttpCallSite[] = [];

    let literalCount = 0;
    let envRefCount = 0;
    let patternCount = 0;
    let unresolvedCount = 0;
    let internalCount = 0;
    let externalCount = 0;

    for (const s of sites) {
        // Tally by URL kind (informational).
        switch (s.url.kind) {
            case 'literal':
                literalCount += 1;
                break;
            case 'env-ref':
                envRefCount += 1;
                break;
            case 'pattern':
                patternCount += 1;
                break;
            case 'unresolved':
                unresolvedCount += 1;
                break;
        }

        const target = classifyTarget(s.url, httpCfg);

        if (target.kind === 'unresolved') {
            unresolved.push(s);
            continue;
        }

        const owner = ownership.findOwner(s.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(s);
            continue;
        }

        if (target.kind === 'internal') {
            internalCount += 1;
            const ownerId = ensureOwner(ownerNodes, owner);
            const targetId = ensureTargetService(targetNodes, target.serviceId);
            const key = `http-call:${ownerId}->${targetId}`;
            if (!edges.has(key)) {
                edges.set(key, {
                    id: key,
                    from: ownerId,
                    to: targetId,
                    kind: 'http-call',
                    file: s.location.file,
                    line: s.location.line,
                    meta: {
                        method: s.method,
                        api: s.api,
                        via: target.via,
                        ...(s.enclosingClass !== undefined ? { enclosingClass: s.enclosingClass } : {}),
                    },
                });
            }
            continue;
        }

        // external
        externalCount += 1;
        externalCalls.push(s);
        const ownerId = ensureOwner(ownerNodes, owner);
        const externalId = ensureExternal(targetNodes, target.hostname);
        const key = `http-external:${ownerId}->${externalId}`;
        if (!edges.has(key)) {
            edges.set(key, {
                id: key,
                from: ownerId,
                to: externalId,
                kind: 'http-external',
                file: s.location.file,
                line: s.location.line,
                meta: {
                    method: s.method,
                    api: s.api,
                    ...(s.enclosingClass !== undefined ? { enclosingClass: s.enclosingClass } : {}),
                },
            });
        }
    }

    return {
        nodes: [...ownerNodes.values(), ...targetNodes.values()],
        edges: [...edges.values()],
        diagnostics: {
            unresolved,
            unowned,
            externalCalls,
            counts: {
                totalSites: sites.length,
                literal: literalCount,
                envRef: envRefCount,
                pattern: patternCount,
                unresolved: unresolvedCount,
                internal: internalCount,
                external: externalCount,
                unowned: unowned.length,
            },
        },
    };
}

/**
 * Classify a `ResolvedUrl` against the internal-services config.
 *
 * Rules:
 *   - env-ref matched against `internalServices[*].envVars`     → internal
 *   - env-ref unmatched (no known service for envVar)           → unresolved
 *     (rationale: we have no hostname to attribute it to, so emitting an
 *      `external:<env-var>` node would clutter the graph with placeholder nodes.
 *      The site still appears in diagnostics; the operator can fix the config.)
 *   - literal matching `internalServices[*].urlPatterns`        → internal
 *   - literal otherwise — try to extract hostname for external-node            → external
 *   - pattern (template with non-resolvable base) — try base→external only if it has a host;
 *      otherwise unresolved
 */
function classifyTarget(
    url: ResolvedUrl,
    cfg: HttpConfig | undefined,
): HttpTarget {
    if (url.kind === 'unresolved') {
        return { kind: 'unresolved', reason: url.reason };
    }
    const services = cfg?.internalServices ?? [];

    if (url.kind === 'env-ref') {
        const match = services.find((s) => (s.envVars ?? []).includes(url.envVar));
        if (match) return { kind: 'internal', serviceId: match.id, via: 'env-ref' };
        return { kind: 'unresolved', reason: `env-ref ${url.envVar} not in internalServices` };
    }

    if (url.kind === 'literal') {
        for (const svc of services) {
            for (const p of svc.urlPatterns ?? []) {
                if (url.value.includes(p)) return { kind: 'internal', serviceId: svc.id, via: 'url-pattern' };
            }
        }
        const host = hostnameOf(url.value);
        if (host) return { kind: 'external', hostname: host };
        return { kind: 'unresolved', reason: 'literal without hostname' };
    }

    // pattern: try to extract a hostname from the pattern text — handles
    // `\`https://api.example.com/${id}\`` (no env-ref but a literal host prefix).
    const host = hostnameOf(url.pattern);
    if (host) {
        for (const svc of services) {
            for (const p of svc.urlPatterns ?? []) {
                if (url.pattern.includes(p)) return { kind: 'internal', serviceId: svc.id, via: 'url-pattern' };
            }
        }
        return { kind: 'external', hostname: host };
    }
    return { kind: 'unresolved', reason: 'pattern without resolvable base' };
}

/**
 * Extracts a hostname from a URL string. Handles full URLs and host-only strings.
 * Returns `null` when the input has no protocol and starts with `/` (a path) or
 * is empty — these aren't routable to an `external:<host>` node.
 */
function hostnameOf(url: string): string | null {
    if (!url || url.startsWith('/')) return null;
    try {
        const u = new URL(url);
        return u.hostname || null;
    } catch {
        // Not a parsable URL; try a relaxed regex for `host[:port]/...` shapes
        // that lack an explicit scheme (rare in practice but cheap to handle).
        const m = url.match(/^([A-Za-z0-9.-]+)(?::\d+)?(?:\/|$)/);
        if (m && m[1] && m[1].includes('.')) return m[1];
        return null;
    }
}

function ensureOwner(nodes: Map<string, GraphNode>, owner: GraphOwnerRef): string {
    const id = ownerNodeId(owner);
    if (!nodes.has(id)) nodes.set(id, ownerNodeFor(owner));
    return id;
}

function ensureTargetService(nodes: Map<string, GraphNode>, id: string): string {
    const nodeId = `service:${id}`;
    if (!nodes.has(nodeId)) {
        nodes.set(nodeId, { id: nodeId, kind: 'service', label: id });
    }
    return nodeId;
}

function ensureExternal(nodes: Map<string, GraphNode>, hostname: string): string {
    const id = `external:${hostname}`;
    if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'external', label: hostname });
    }
    return id;
}

// Re-export for the CLI / tests if they want to enumerate the config.
export function internalServiceNames(cfg: HttpConfig | undefined): string[] {
    return (cfg?.internalServices ?? []).map((s: HttpInternalService) => s.id);
}
