import type {
    CronScheduleDiagnostics,
    CronScheduleSite,
    GraphEdge,
    GraphNode,
    GraphOwnerRef,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { ownerNodeFor, ownerNodeId } from './owner-node.js';

export interface MapCronScheduleResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: CronScheduleDiagnostics;
}

/**
 * Maps cron-schedule sites to graph nodes + edges:
 *
 *   - Each site → one `cron-schedule` node (deduplicated by expression + category)
 *   - Each site → one `cron-triggers` edge from the cron-schedule node to the
 *     owner service/lib node (mirror of BullMQ queue-consume direction; cron-schedule
 *     *triggers* the owner, so edge flows cron-schedule → owner).
 *
 * Dynamic sites (SchedulerRegistry) use the file owner for edge target.
 * Sites whose file falls outside apps/libs are emitted as nodes but flagged unowned
 * (no edge, logged in diagnostics).
 */
export function mapCronScheduleToGraph(
    sites: CronScheduleSite[],
    ownership: OwnershipRegistry,
): MapCronScheduleResult {
    const ownerNodes = new Map<string, GraphNode>();
    const cronNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unowned: CronScheduleSite[] = [];

    let cronCount = 0;
    let intervalCount = 0;
    let timeoutCount = 0;
    let dynamicCount = 0;

    for (const site of sites) {
        switch (site.category) {
            case 'cron': cronCount++; break;
            case 'interval': intervalCount++; break;
            case 'timeout': timeoutCount++; break;
            case 'dynamic': dynamicCount++; break;
        }

        // Build cron-schedule node
        const nodeId = buildCronNodeId(site);
        if (!cronNodes.has(nodeId)) {
            cronNodes.set(nodeId, buildCronNode(nodeId, site));
        }

        // Resolve owner
        const owner = ownership.findOwner(site.location.file);
        if (owner.kind === 'unknown') {
            unowned.push(site);
            continue;
        }

        const ownerId = ensureOwner(ownerNodes, owner);
        const edgeKey = `cron-triggers:${nodeId}->${ownerId}`;
        if (!edges.has(edgeKey)) {
            edges.set(edgeKey, {
                id: edgeKey,
                from: nodeId,
                to: ownerId,
                kind: 'cron-triggers',
                file: site.location.file,
                line: site.location.line,
                meta: {
                    owner: site.owner,
                    category: site.category,
                    ...(site.name !== undefined ? { name: site.name } : {}),
                },
            });
        }
    }

    const allNodes = [...ownerNodes.values(), ...cronNodes.values()];
    const allEdges = [...edges.values()];

    return {
        nodes: allNodes,
        edges: allEdges,
        diagnostics: {
            unowned,
            counts: {
                totalSites: sites.length,
                cron: cronCount,
                interval: intervalCount,
                timeout: timeoutCount,
                dynamic: dynamicCount,
                unowned: unowned.length,
                nodesEmitted: cronNodes.size,
                edgesEmitted: allEdges.length,
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Node ID: `cron-schedule:<category>:<expression-or-owner>`.
 * For decorator-based sites, use the expression (dedup equal expressions).
 * For dynamic sites, include owner to avoid false dedup across different call sites.
 */
function buildCronNodeId(site: CronScheduleSite): string {
    const expr = site.resolvedExpression ?? site.expression;
    if (site.category === 'dynamic') {
        return `cron-schedule:dynamic:${site.owner}:${expr}`;
    }
    return `cron-schedule:${site.category}:${expr}`;
}

function buildCronNode(id: string, site: CronScheduleSite): GraphNode {
    const label = site.name
        ? site.name
        : site.humanReadable ?? (site.resolvedExpression ?? site.expression);

    return {
        id,
        kind: 'cron-schedule',
        label,
        meta: {
            expression: site.expression,
            ...(site.resolvedExpression !== undefined
                ? { resolvedExpression: site.resolvedExpression }
                : {}),
            ...(site.humanReadable !== undefined ? { humanReadable: site.humanReadable } : {}),
            category: site.category,
            owner: site.owner,
            ...(site.name !== undefined ? { name: site.name } : {}),
        },
    };
}

function ensureOwner(nodes: Map<string, GraphNode>, owner: GraphOwnerRef): string {
    const id = ownerNodeId(owner);
    if (!nodes.has(id)) nodes.set(id, ownerNodeFor(owner));
    return id;
}
