/**
 * Tests for src/mapper/fe-to-graph.ts
 *
 * Covers: component/hook/route/page nodes, fe-imports/fe-renders/fe-routes-to edges,
 * deduplication, unresolved render refs, unowned diagnostics, empty input.
 *
 * Node IDs are file-qualified: fe-component:<file>#<name>, fe-hook:<file>#<name>.
 */

import { describe, expect, it } from 'vitest';
import { mapFeToGraph } from './fe-to-graph.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import type { FeExtractResult } from '../extractors/fe/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOwnership(
    services: Array<{ id: string; rootDir: string }> = [],
    libs: Array<{ id: string; rootDir: string }> = [],
): OwnershipRegistry {
    return new OwnershipRegistry(
        '/root',
        services.map((s) => ({ ...s, tsconfigPath: null, entryFile: null })),
        libs,
    );
}

function emptyExtract(): FeExtractResult {
    return { components: [], hooks: [], routes: [], pages: [], renders: [], imports: [], unresolvedImports: [] };
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------
describe('mapFeToGraph — empty input', () => {
    it('returns empty nodes, edges, and diagnostics for empty input', () => {
        const result = mapFeToGraph(emptyExtract(), makeOwnership());
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
        expect(result.diagnostics.unresolved).toHaveLength(0);
        expect(result.diagnostics.unowned).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Component nodes
// ---------------------------------------------------------------------------
describe('mapFeToGraph — component nodes', () => {
    it('emits fe-component node for each component with file-qualified id', () => {
        const FILE = '/app/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        const nodeId = `fe-component:${FILE}#Button`;
        expect(nodes.some((n) => n.id === nodeId && n.kind === 'fe-component')).toBe(true);
    });

    it('emits distinct nodes for same-named components in different files', () => {
        const FILE1 = '/app/Button.tsx';
        const FILE2 = '/app/Button2.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: FILE1, location: { file: FILE1, line: 1, column: 0 }, exported: true, defaultExport: false },
                { name: 'Button', kind: 'arrow', file: FILE2, location: { file: FILE2, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        // Both should be present (no cross-file dedup)
        expect(nodes.filter((n) => n.kind === 'fe-component')).toHaveLength(2);
        expect(nodes.some((n) => n.id === `fe-component:${FILE1}#Button`)).toBe(true);
        expect(nodes.some((n) => n.id === `fe-component:${FILE2}#Button`)).toBe(true);
    });

    it('deduplicates components with same file and name', () => {
        const FILE = '/app/Button.tsx';
        const comp = { name: 'Button', kind: 'arrow' as const, file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false };
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [comp, comp],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.filter((n) => n.id === `fe-component:${FILE}#Button`)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Hook nodes
// ---------------------------------------------------------------------------
describe('mapFeToGraph — hook nodes', () => {
    it('emits fe-hook node with file-qualified id', () => {
        const FILE = '/app/useCounter.ts';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            hooks: [{ name: 'useCounter', file: FILE, location: { file: FILE, line: 1, column: 0 } }],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.some((n) => n.id === `fe-hook:${FILE}#useCounter` && n.kind === 'fe-hook')).toBe(true);
    });

    it('deduplicates hook nodes with same file and name', () => {
        const FILE = '/app/useAuth.ts';
        const hook = { name: 'useAuth', file: FILE, location: { file: FILE, line: 1, column: 0 } };
        const extract: FeExtractResult = {
            ...emptyExtract(),
            hooks: [hook, hook],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.filter((n) => n.id === `fe-hook:${FILE}#useAuth`)).toHaveLength(1);
    });

    it('emits distinct nodes for same-named hooks in different files', () => {
        const FILE1 = '/app/useAuth.ts';
        const FILE2 = '/lib/useAuth.ts';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            hooks: [
                { name: 'useAuth', file: FILE1, location: { file: FILE1, line: 1, column: 0 } },
                { name: 'useAuth', file: FILE2, location: { file: FILE2, line: 1, column: 0 } },
            ],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.filter((n) => n.kind === 'fe-hook')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Route and page nodes + fe-routes-to edges
// ---------------------------------------------------------------------------
describe('mapFeToGraph — routes and pages', () => {
    it('emits fe-route and fe-page nodes', () => {
        const PAGE_FILE = '/app/pages/users.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/users', pageFile: PAGE_FILE }],
            pages: [{ name: 'UsersPage', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, route: '/users', router: 'pages' }],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.some((n) => n.kind === 'fe-route' && n.id === 'fe-route:/users')).toBe(true);
        expect(nodes.some((n) => n.kind === 'fe-page' && n.id === `fe-page:${PAGE_FILE}#UsersPage`)).toBe(true);
    });

    it('emits fe-routes-to edge from route to page', () => {
        const PAGE_FILE = '/app/pages/about.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/about', pageFile: PAGE_FILE }],
            pages: [{ name: 'AboutPage', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, route: '/about', router: 'pages' }],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        const e = edges.find((e) => e.kind === 'fe-routes-to');
        expect(e).toBeDefined();
        expect(e!.from).toBe('fe-route:/about');
        expect(e!.to).toBe(`fe-page:${PAGE_FILE}#AboutPage`);
    });
});

// ---------------------------------------------------------------------------
// fe-renders edges
// ---------------------------------------------------------------------------
describe('mapFeToGraph — fe-renders edges', () => {
    it('emits fe-renders edge when both components are known', () => {
        const PAGE_FILE = '/app/Page.tsx';
        const BTN_FILE = '/app/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
                { name: 'Button', kind: 'arrow', file: BTN_FILE, location: { file: BTN_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            renders: [
                { fromFile: PAGE_FILE, fromName: 'Page', toName: 'Button', location: { file: PAGE_FILE, line: 2, column: 0 } },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        expect(edges.some((e) =>
            e.kind === 'fe-renders' &&
            e.from === `fe-component:${PAGE_FILE}#Page` &&
            e.to === `fe-component:${BTN_FILE}#Button`,
        )).toBe(true);
    });

    it('prefers same-file component for render target', () => {
        // If Button exists in the same file as Page, use that one
        const FILE = '/app/Page.tsx';
        const OTHER_FILE = '/app/Other.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
                { name: 'Button', kind: 'arrow', file: FILE, location: { file: FILE, line: 5, column: 0 }, exported: true, defaultExport: false },
                { name: 'Button', kind: 'arrow', file: OTHER_FILE, location: { file: OTHER_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            renders: [
                { fromFile: FILE, fromName: 'Page', toName: 'Button', location: { file: FILE, line: 2, column: 0 } },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        const renderEdge = edges.find((e) => e.kind === 'fe-renders');
        expect(renderEdge).toBeDefined();
        // Should use the same-file Button
        expect(renderEdge!.to).toBe(`fe-component:${FILE}#Button`);
    });

    it('routes unresolved render to diagnostics', () => {
        const FILE = '/app/Page.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            renders: [
                { fromFile: FILE, fromName: 'Page', toName: 'UnknownComp', location: { file: FILE, line: 2, column: 0 } },
            ],
        };
        const { edges, diagnostics } = mapFeToGraph(extract, makeOwnership());
        expect(edges.filter((e) => e.kind === 'fe-renders')).toHaveLength(0);
        expect(diagnostics.unresolved.some((u) => u.ref === 'UnknownComp')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// fe-imports edges
// ---------------------------------------------------------------------------
describe('mapFeToGraph — fe-imports edges', () => {
    it('emits fe-imports edge from page to component when resolved file matches', () => {
        const BTN_FILE = '/app/components/Button.tsx';
        const PAGE_FILE = '/app/pages/index.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: BTN_FILE, location: { file: BTN_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            pages: [
                { name: 'HomePage', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, route: '/', router: 'pages' },
            ],
            routes: [{ pattern: '/', pageFile: PAGE_FILE }],
            imports: [
                {
                    sourceFile: PAGE_FILE,
                    resolvedFile: BTN_FILE,
                    importedName: 'Button',
                    specifier: '../components/Button',
                    location: { file: PAGE_FILE, line: 2, column: 0 },
                },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        const e = edges.find((e) => e.kind === 'fe-imports');
        expect(e).toBeDefined();
        expect(e!.from).toBe(`fe-page:${PAGE_FILE}#HomePage`);
        expect(e!.to).toBe(`fe-component:${BTN_FILE}#Button`);
    });

    it('skips import when resolvedFile is null and records in diagnostics', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: '/app/Button.tsx', location: { file: '/app/Button.tsx', line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            imports: [
                {
                    sourceFile: '/app/pages/index.tsx',
                    resolvedFile: null,
                    importedName: 'Button',
                    specifier: '../Button',
                    location: { file: '/app/pages/index.tsx', line: 1, column: 0 },
                },
            ],
        };
        const { edges, diagnostics } = mapFeToGraph(extract, makeOwnership());
        expect(edges.filter((e) => e.kind === 'fe-imports')).toHaveLength(0);
        // null resolvedFile pushes to diagnostics (P0-5)
        expect(diagnostics.unresolved.some((u) => u.kind === 'fe-imports' && u.reason === 'unresolved-file')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Deduplication of nodes
// ---------------------------------------------------------------------------
describe('mapFeToGraph — node deduplication', () => {
    it('deduplicates route nodes with same pattern', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [
                { pattern: '/about', pageFile: '/app/pages/about.tsx' },
                { pattern: '/about', pageFile: '/app/pages/about-v2.tsx' },
            ],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        expect(nodes.filter((n) => n.id === 'fe-route:/about')).toHaveLength(1);
    });

    it('does not deduplicate page nodes with same name but different files', () => {
        const FILE1 = '/app/pages/about.tsx';
        const FILE2 = '/app/pages/about2.tsx';
        const page = { name: 'AboutPage', file: FILE1, location: { file: FILE1, line: 1, column: 0 }, route: '/about', router: 'pages' as const };
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/about', pageFile: FILE1 }],
            pages: [page, { ...page, file: FILE2 }],
        };
        const { nodes } = mapFeToGraph(extract, makeOwnership());
        // File-qualified IDs: two distinct nodes for same name in different files
        expect(nodes.filter((n) => n.kind === 'fe-page')).toHaveLength(2);
        expect(nodes.some((n) => n.id === `fe-page:${FILE1}#AboutPage`)).toBe(true);
        expect(nodes.some((n) => n.id === `fe-page:${FILE2}#AboutPage`)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Page in same file as component (fileToNodes already has entry)
// ---------------------------------------------------------------------------
describe('mapFeToGraph — page colocated with component', () => {
    it('handles page and component in same file', () => {
        const FILE = '/app/pages/index.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Hero', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            routes: [{ pattern: '/', pageFile: FILE }],
            pages: [
                { name: 'HomePage', file: FILE, location: { file: FILE, line: 5, column: 0 }, route: '/', router: 'pages' },
            ],
        };
        const { nodes, edges } = mapFeToGraph(extract, makeOwnership());
        // Both fe-component and fe-page nodes should exist
        expect(nodes.some((n) => n.kind === 'fe-component' && n.id === `fe-component:${FILE}#Hero`)).toBe(true);
        expect(nodes.some((n) => n.kind === 'fe-page' && n.id === `fe-page:${FILE}#HomePage`)).toBe(true);
        expect(edges.some((e) => e.kind === 'fe-routes-to')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// fe-imports edge deduplication
// ---------------------------------------------------------------------------
describe('mapFeToGraph — fe-imports deduplication', () => {
    it('does not emit duplicate fe-imports edge for same (from, to) pair', () => {
        const PAGE_FILE = '/app/pages/index.tsx';
        const BTN_FILE = '/app/components/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
                { name: 'Button', kind: 'arrow', file: BTN_FILE, location: { file: BTN_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            imports: [
                {
                    sourceFile: PAGE_FILE,
                    resolvedFile: BTN_FILE,
                    importedName: 'Button',
                    specifier: '../components/Button',
                    location: { file: PAGE_FILE, line: 2, column: 0 },
                },
                // Duplicate import
                {
                    sourceFile: PAGE_FILE,
                    resolvedFile: BTN_FILE,
                    importedName: 'Button',
                    specifier: '../components/Button',
                    location: { file: PAGE_FILE, line: 3, column: 0 },
                },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        const feImports = edges.filter((e) => e.kind === 'fe-imports');
        expect(feImports).toHaveLength(1);
    });

    it('skips import where target file has no components', () => {
        const PAGE_FILE = '/app/pages/index.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: PAGE_FILE, location: { file: PAGE_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            imports: [
                {
                    sourceFile: PAGE_FILE,
                    resolvedFile: '/app/utils/helpers.tsx',  // no component here
                    importedName: 'formatDate',
                    specifier: '../utils/helpers',
                    location: { file: PAGE_FILE, line: 2, column: 0 },
                },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        expect(edges.filter((e) => e.kind === 'fe-imports')).toHaveLength(0);
    });

    it('skips self-loop edge (fromId === toId)', () => {
        // A component that imports from the same file (self-import) should not produce an edge
        const FILE = '/app/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            imports: [
                {
                    sourceFile: FILE,
                    resolvedFile: FILE,  // self-import
                    importedName: 'Button',
                    specifier: './Button',
                    location: { file: FILE, line: 1, column: 0 },
                },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        expect(edges.filter((e) => e.kind === 'fe-imports')).toHaveLength(0);
    });

    it('skips import where source file has no components or pages', () => {
        const BTN_FILE = '/app/components/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: BTN_FILE, location: { file: BTN_FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            imports: [
                {
                    sourceFile: '/app/utils/noncomponent.tsx',  // no component in source
                    resolvedFile: BTN_FILE,
                    importedName: 'Button',
                    specifier: '../components/Button',
                    location: { file: '/app/utils/noncomponent.tsx', line: 1, column: 0 },
                },
            ],
        };
        const { edges } = mapFeToGraph(extract, makeOwnership());
        expect(edges.filter((e) => e.kind === 'fe-imports')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Ownership diagnostics
// ---------------------------------------------------------------------------
describe('mapFeToGraph — unowned diagnostics', () => {
    it('reports unowned component', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const FILE = '/tmp/Orphan.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Orphan', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: false, defaultExport: false },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned.some((u) => u.file === FILE)).toBe(true);
    });

    it('does not report owned component as unowned', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const FILE = '/apps/web/Button.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned).toHaveLength(0);
    });

    it('reports unowned page', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/about', pageFile: '/tmp/pages/about.tsx' }],
            pages: [
                { name: 'AboutPage', file: '/tmp/pages/about.tsx', location: { file: '/tmp/pages/about.tsx', line: 1, column: 0 }, route: '/about', router: 'pages' },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned.some((u) => u.kind === 'fe-page')).toBe(true);
    });

    it('does not report owned page as unowned', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/', pageFile: '/apps/web/pages/index.tsx' }],
            pages: [
                { name: 'HomePage', file: '/apps/web/pages/index.tsx', location: { file: '/apps/web/pages/index.tsx', line: 1, column: 0 }, route: '/', router: 'pages' },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned.filter((u) => u.kind === 'fe-page')).toHaveLength(0);
    });

    it('reports unowned hook', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const FILE = '/tmp/useOrphan.ts';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            hooks: [{ name: 'useOrphan', file: FILE, location: { file: FILE, line: 1, column: 0 } }],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned.some((u) => u.kind === 'fe-hook' && u.file === FILE)).toBe(true);
    });

    it('reports unowned route', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/orphan', pageFile: '/tmp/pages/orphan.tsx' }],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.unowned.some((u) => u.kind === 'fe-route' && u.file === '/tmp/pages/orphan.tsx')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Extractor unresolved imports forwarded to diagnostics (P0-5)
// ---------------------------------------------------------------------------
describe('mapFeToGraph — extractor unresolved imports in diagnostics', () => {
    it('carries unresolved imports from extractor into diagnostics', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            unresolvedImports: [
                { file: '/app/Comp.tsx', specifier: '../missing', error: 'File not found' },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, makeOwnership());
        expect(diagnostics.unresolved.some((u) => u.kind === 'fe-imports' && u.ref === '../missing')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// diagnostics.counts field (P1 type-design follow-up)
// ---------------------------------------------------------------------------
describe('mapFeToGraph — diagnostics.counts', () => {
    it('counts zero unresolved and unowned for empty input', () => {
        const { diagnostics } = mapFeToGraph(emptyExtract(), makeOwnership());
        expect(diagnostics.counts.unresolvedImports).toBe(0);
        expect(diagnostics.counts.unresolvedRenders).toBe(0);
        expect(diagnostics.counts.unowned).toBe(0);
    });

    it('counts unresolved imports from extractor', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            unresolvedImports: [
                { file: '/app/A.tsx', specifier: '../missing1', error: 'not found' },
                { file: '/app/B.tsx', specifier: '../missing2', error: 'not found' },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, makeOwnership());
        expect(diagnostics.counts.unresolvedImports).toBe(2);
    });

    it('counts unresolved renders', () => {
        const FILE = '/app/Page.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Page', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            renders: [
                { fromFile: FILE, fromName: 'Page', toName: 'Unknown', location: { file: FILE, line: 2, column: 0 } },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, makeOwnership());
        expect(diagnostics.counts.unresolvedRenders).toBe(1);
    });

    it('counts unowned items', () => {
        const ownership = makeOwnership([{ id: 'web', rootDir: '/apps/web' }]);
        const FILE = '/tmp/Orphan.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Orphan', kind: 'arrow', file: FILE, location: { file: FILE, line: 1, column: 0 }, exported: false, defaultExport: false },
            ],
        };
        const { diagnostics } = mapFeToGraph(extract, ownership);
        expect(diagnostics.counts.unowned).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Diagnostics classification: actionable local misses vs external/package noise
// ---------------------------------------------------------------------------
describe('mapFeToGraph — diagnostics classification', () => {
    it('classifies unresolved FE imports by package, workspace alias, and relative path', () => {
        const FILE = '/app/Page.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            imports: [
                {
                    sourceFile: FILE,
                    resolvedFile: null,
                    importedName: 'Stack',
                    specifier: '@mui/material',
                    location: { file: FILE, line: 1, column: 0 },
                },
                {
                    sourceFile: FILE,
                    resolvedFile: null,
                    importedName: 'TargetButton',
                    specifier: '@workspace/ui',
                    location: { file: FILE, line: 2, column: 0 },
                },
                {
                    sourceFile: FILE,
                    resolvedFile: null,
                    importedName: 'LocalButton',
                    specifier: './missing-button',
                    location: { file: FILE, line: 3, column: 0 },
                },
            ],
        };

        const { diagnostics } = mapFeToGraph(extract, makeOwnership());

        expect(diagnostics.unresolved).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'fe-imports',
                    ref: '@mui/material',
                    classification: 'external-package',
                }),
                expect.objectContaining({
                    kind: 'fe-imports',
                    ref: '@workspace/ui',
                    classification: 'workspace-alias-unresolved',
                }),
                expect.objectContaining({
                    kind: 'fe-imports',
                    ref: './missing-button',
                    classification: 'local-file-unresolved',
                }),
            ]),
        );
        expect(diagnostics.counts.externalPackageImports).toBe(1);
        expect(diagnostics.counts.workspaceAliasUnresolved).toBe(1);
        expect(diagnostics.counts.localFileUnresolved).toBe(1);
    });

    it('classifies unresolved renders imported from external packages separately from local JSX misses', () => {
        const FILE = '/app/Page.tsx';
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                {
                    name: 'Page',
                    kind: 'arrow',
                    file: FILE,
                    location: { file: FILE, line: 4, column: 0 },
                    exported: true,
                    defaultExport: false,
                },
            ],
            imports: [
                {
                    sourceFile: FILE,
                    resolvedFile: null,
                    importedName: 'Stack',
                    specifier: '@mui/material',
                    location: { file: FILE, line: 1, column: 0 },
                },
            ],
            renders: [
                { fromFile: FILE, fromName: 'Page', toName: 'Stack', location: { file: FILE, line: 5, column: 0 } },
                { fromFile: FILE, fromName: 'Page', toName: 'MissingLocal', location: { file: FILE, line: 6, column: 0 } },
            ],
        };

        const { diagnostics } = mapFeToGraph(extract, makeOwnership());

        expect(diagnostics.unresolved).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'fe-renders',
                    ref: 'Stack',
                    classification: 'external-package',
                    reason: 'external-component',
                }),
                expect.objectContaining({
                    kind: 'fe-renders',
                    ref: 'MissingLocal',
                    classification: 'tsx-component-unresolved',
                    reason: 'component-not-found',
                }),
            ]),
        );
        expect(diagnostics.counts.externalComponentRenders).toBe(1);
        expect(diagnostics.counts.tsxComponentUnresolved).toBe(1);
    });
});
