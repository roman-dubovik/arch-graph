import type {
    DiDiagnostics,
    DiModuleRef,
    DiModuleSite,
    DiProviderRef,
    GraphEdge,
    GraphNode,
} from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { DiModuleIndex } from '../extractors/di/module-index.js';

export interface MapDiResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    diagnostics: DiDiagnostics;
}

/**
 * Maps DI module sites to graph nodes and edges.
 *
 *   module:<ClassName>  — every `@Module`-decorated class, plus every class
 *                         referenced from another module's imports/providers/exports.
 *   provider:<Name>     — every entry in `providers` / `exports` / `controllers`
 *                         that resolved to a class or token.
 *
 *   module:A -> module:B   kind: 'di-import'      A imports B
 *   module:A -> provider:S kind: 'di-provides'    A declares S
 *   module:A -> provider:S kind: 'di-exports'     A re-exports S
 *   module:A -> provider:C kind: 'di-controller'  A registers controller C
 *
 * Dedup: one edge per (from, to, kind). First-seen location wins.
 *
 * Unresolved refs (spread, dynamic, `<no-provide>`) are diverted to diagnostics
 * and NOT emitted as edges — emitting a sentinel `provider:<no-provide>` would
 * pollute the graph with non-architectural nodes.
 */
export function mapDiToGraph(
    modules: DiModuleSite[],
    moduleIndex: DiModuleIndex,
    ownership: OwnershipRegistry,
): MapDiResult {
    const moduleNodes = new Map<string, GraphNode>();
    const providerNodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const unresolvedRefs: DiDiagnostics['unresolvedRefs'] = [];
    const unowned: DiModuleSite[] = [];

    let importsCount = 0;
    let providersCount = 0;
    let exportsCount = 0;
    let controllersCount = 0;

    for (const mod of modules) {
        importsCount += mod.imports.length;
        providersCount += mod.providers.length;
        exportsCount += mod.exports.length;
        controllersCount += mod.controllers.length;

        const owner = ownership.findOwner(mod.location.file);
        // Modules outside apps/ and libs/ — record but still emit the node so
        // `imports: [<this>]` from owned modules can resolve. Architecturally
        // these are typically test fixtures or root configs; surface in diagnostics.
        if (owner.kind === 'unknown') {
            unowned.push(mod);
        }

        const modNodeId = `module:${mod.className}`;
        const modNode = ensureModuleNode(moduleNodes, mod.className, moduleIndex);
        // `declaredAt` accumulates file:line of every `@Module` declaration for this class
        // (typically a singleton, but DI doesn't enforce uniqueness — duplicate class names
        // across files produce one node and we keep all sites for debugging).
        const decl = `${mod.location.file}:${mod.location.line}`;
        const decls = (modNode.meta?.declaredAt as string[] | undefined) ?? [];
        if (!decls.includes(decl)) {
            modNode.meta = { ...(modNode.meta ?? {}), declaredAt: [...decls, decl] };
        }

        // imports: module -> module
        for (const ref of mod.imports) {
            if (ref.kind === 'unresolved') {
                unresolvedRefs.push({ moduleClass: mod.className, field: 'imports', ref, location: mod.location });
                continue;
            }
            const targetId = `module:${ref.name}`;
            ensureModuleNode(moduleNodes, ref.name, moduleIndex);
            addEdge(edges, modNodeId, targetId, 'di-import', mod, refMeta(ref));
        }

        // providers: module -> provider
        for (const ref of mod.providers) {
            if (ref.kind === 'unresolved') {
                unresolvedRefs.push({ moduleClass: mod.className, field: 'providers', ref, location: mod.location });
                continue;
            }
            const providerId = ensureProviderNode(providerNodes, ref);
            addEdge(edges, modNodeId, providerId, 'di-provides', mod, refMeta(ref));
        }

        // exports: module -> provider
        for (const ref of mod.exports) {
            if (ref.kind === 'unresolved') {
                unresolvedRefs.push({ moduleClass: mod.className, field: 'exports', ref, location: mod.location });
                continue;
            }
            // NestJS allows `exports: [SomeModule]` (re-export entire module). We model both as
            // `provider:<Name>` for simplicity — the same name space; a re-exported module
            // typically also appears as a `module:<Name>` node, so the consumer can join.
            const providerId = ensureProviderNode(providerNodes, ref);
            addEdge(edges, modNodeId, providerId, 'di-exports', mod, refMeta(ref));
        }

        // controllers: module -> provider (with kind=controller in meta)
        for (const ref of mod.controllers) {
            if (ref.kind === 'unresolved') {
                unresolvedRefs.push({ moduleClass: mod.className, field: 'controllers', ref, location: mod.location });
                continue;
            }
            const providerId = ensureProviderNode(providerNodes, ref);
            const node = providerNodes.get(providerId)!;
            node.meta = { ...(node.meta ?? {}), isController: true };
            addEdge(edges, modNodeId, providerId, 'di-controller', mod, refMeta(ref));
        }
    }

    return {
        nodes: [...moduleNodes.values(), ...providerNodes.values()],
        edges: [...edges.values()],
        diagnostics: {
            unresolvedRefs,
            unowned,
            counts: {
                modules: modules.length,
                imports: importsCount,
                providers: providersCount,
                exports: exportsCount,
                controllers: controllersCount,
                unresolvedRefs: unresolvedRefs.length,
                unowned: unowned.length,
            },
        },
    };
}

function ensureModuleNode(
    nodes: Map<string, GraphNode>,
    className: string,
    idx: DiModuleIndex,
): GraphNode {
    const id = `module:${className}`;
    const existing = nodes.get(id);
    if (existing) return existing;

    // `meta.local = true` iff this module's `@Module` decorator was found inside the project's
    // sources; `false` for externals like `TypeOrmModule` / `ConfigModule` brought in from
    // `node_modules` (we never see their source files). Visualisation downstream uses this
    // to dim or hide external modules.
    const indexed = idx.get(className);
    const node: GraphNode = {
        id,
        kind: 'module',
        label: className,
        ...(indexed ? { path: indexed.file } : {}),
        meta: { local: indexed !== undefined },
    };
    nodes.set(id, node);
    return node;
}

function ensureProviderNode(nodes: Map<string, GraphNode>, ref: DiProviderRef): string {
    if (ref.kind === 'unresolved') {
        throw new Error('ensureProviderNode called with unresolved ref — caller must filter');
    }
    const id = `provider:${ref.name}`;
    if (!nodes.has(id)) {
        const meta: Record<string, unknown> = {};
        if (ref.kind === 'token') {
            meta.providerKind = ref.providerKind;
            if (ref.provideToken) meta.provideToken = ref.provideToken;
        } else {
            meta.providerKind = 'class';
        }
        nodes.set(id, { id, kind: 'provider', label: ref.name, meta });
    }
    return id;
}

function addEdge(
    edges: Map<string, GraphEdge>,
    from: string,
    to: string,
    kind: GraphEdge['kind'],
    mod: DiModuleSite,
    meta: Record<string, unknown>,
): void {
    const key = `${kind}:${from}->${to}`;
    if (edges.has(key)) return;
    edges.set(key, {
        id: key,
        from,
        to,
        kind,
        file: mod.location.file,
        line: mod.location.line,
        meta: { fromModule: mod.className, ...meta },
    });
}

function refMeta(ref: DiModuleRef | DiProviderRef): Record<string, unknown> {
    if (ref.kind === 'class') return { refKind: 'class' };
    if (ref.kind === 'dynamic') return { refKind: 'dynamic', via: ref.via };
    if (ref.kind === 'token') {
        return {
            refKind: 'token',
            providerKind: ref.providerKind,
            ...(ref.provideToken ? { provideToken: ref.provideToken } : {}),
        };
    }
    return {};
}
