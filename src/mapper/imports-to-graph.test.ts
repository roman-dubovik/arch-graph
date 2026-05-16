/**
 * Tests for src/mapper/imports-to-graph.ts.
 *
 * Covers: cjs-require edge emission (same as static), dynamic-non-literal
 * routing, diagnostics population, counts, file-level edges, antipattern flags,
 * same-owner skip, unknown-owner skip, lib-usage dedup / importCount increment.
 */

import type { TsImportSite } from '../core/types.js';
import { OwnershipRegistry } from '../core/service-registry.js';
import { mapImportsToGraph } from './imports-to-graph.js';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeOwnership(
    services: Array<{ id: string; rootDir: string }>,
    libs: Array<{ id: string; rootDir: string }>,
): OwnershipRegistry {
    return new OwnershipRegistry(
        '/root',
        services.map((s) => ({ ...s, tsconfigPath: null, entryFile: null })),
        libs,
    );
}

function staticSite(opts: {
    sourceFile: string;
    specifier: string;
    resolvedFile?: string;
    kind?: 'external' | 'broken-relative' | 'broken-alias';
    packageName?: string;
    typeOnly?: boolean;
}): TsImportSite {
    const resolution =
        opts.resolvedFile != null
            ? { kind: 'resolved' as const, filePath: opts.resolvedFile }
            : opts.kind === 'external'
              ? { kind: 'external' as const, packageName: opts.packageName ?? 'pkg' }
              : opts.kind === 'broken-alias'
                ? { kind: 'broken-alias' as const, reason: 'alias-prefix-matched-file-not-found' as const }
                : { kind: 'broken-relative' as const, reason: 'file-not-found' as const };
    return {
        sourceFile: opts.sourceFile,
        specifier: opts.specifier,
        resolution,
        kind: 'static',
        typeOnly: opts.typeOnly ?? false,
        specifierShape: 'relative',
        location: { file: opts.sourceFile, line: 1, column: 0 },
    };
}

function cjsSite(opts: {
    sourceFile: string;
    specifier: string;
    resolvedFile?: string;
    kind?: 'external' | 'broken-relative' | 'broken-alias' | 'dynamic-non-literal';
    packageName?: string;
}): TsImportSite {
    let resolution: TsImportSite['resolution'];
    if (opts.resolvedFile != null) {
        resolution = { kind: 'resolved', filePath: opts.resolvedFile };
    } else if (opts.kind === 'external') {
        resolution = { kind: 'external', packageName: opts.packageName ?? 'pkg' };
    } else if (opts.kind === 'broken-alias') {
        resolution = { kind: 'broken-alias', reason: 'alias-prefix-matched-file-not-found' };
    } else if (opts.kind === 'dynamic-non-literal') {
        resolution = { kind: 'dynamic-non-literal' };
    } else {
        resolution = { kind: 'broken-relative', reason: 'file-not-found' };
    }
    return {
        sourceFile: opts.sourceFile,
        specifier: opts.specifier,
        resolution,
        kind: 'cjs-require',
        typeOnly: false,
        specifierShape: 'relative',
        location: { file: opts.sourceFile, line: 1, column: 0 },
    };
}

function dynamicSite(opts: {
    sourceFile: string;
    specifier: string;
    resolvedFile?: string;
    nonLiteral?: boolean;
}): TsImportSite {
    const resolution = opts.nonLiteral
        ? { kind: 'dynamic-non-literal' as const }
        : opts.resolvedFile
          ? { kind: 'resolved' as const, filePath: opts.resolvedFile }
          : { kind: 'external' as const, packageName: 'pkg' };
    return {
        sourceFile: opts.sourceFile,
        specifier: opts.specifier,
        resolution,
        kind: 'dynamic',
        typeOnly: false,
        specifierShape: 'relative',
        location: { file: opts.sourceFile, line: 1, column: 0 },
    };
}

// ---------------------------------------------------------------------------
// CJS require — resolved sites produce ts-import + lib-usage
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — cjs-require resolved sites', () => {
    it('emits lib-usage edge for cjs-require (cross-owner)', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            cjsSite({
                sourceFile: '/root/apps/svc-a/src/main.ts',
                specifier: '../libs/shared/index',
                resolvedFile: '/root/libs/shared/index.ts',
            }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.edges.some((e) => e.kind === 'lib-usage')).toBe(true);
        const libEdge = result.edges.find((e) => e.kind === 'lib-usage')!;
        expect(libEdge.from).toBe('service:svc-a');
        expect(libEdge.to).toBe('lib:libs/shared');
    });

    it('cjs-require resolved edge is identical to static resolved edge', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const resFile = '/root/libs/shared/index.ts';
        const staticResult = mapImportsToGraph(
            [staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: resFile })],
            ownership,
            { fileLevel: false },
        );
        const cjsResult = mapImportsToGraph(
            [cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: resFile })],
            ownership,
            { fileLevel: false },
        );
        // Both produce one lib-usage edge with the same from/to/kind
        const sEdge = staticResult.edges.find((e) => e.kind === 'lib-usage')!;
        const cEdge = cjsResult.edges.find((e) => e.kind === 'lib-usage')!;
        expect(cEdge.from).toBe(sEdge.from);
        expect(cEdge.to).toBe(sEdge.to);
        expect(cEdge.kind).toBe(sEdge.kind);
    });

    it('increments totalCjsRequire count', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [],
        );
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'lodash', kind: 'external' }),
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'express', kind: 'external' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.totalCjsRequire).toBe(2);
        expect(result.diagnostics.cjsRequires).toHaveLength(2);
    });

    it('cjs-require site is always pushed into diagnostics.cjsRequires', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            cjsSite({
                sourceFile: '/root/apps/svc-a/src/main.ts',
                specifier: '../libs/shared/index',
                resolvedFile: '/root/libs/shared/index.ts',
            }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.cjsRequires[0]!.kind).toBe('cjs-require');
    });

    it('emits ts-import file-level edge for cjs-require when fileLevel=true', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            cjsSite({
                sourceFile: '/root/apps/svc-a/src/main.ts',
                specifier: '../libs/shared/index',
                resolvedFile: '/root/libs/shared/index.ts',
            }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: true });
        const fileEdges = result.edges.filter((e) => e.kind === 'ts-import');
        expect(fileEdges).toHaveLength(1);
        expect(fileEdges[0]!.meta).toMatchObject({ cjsRequire: true });
    });

    it('deduplicates lib-usage edges (importCount increments)', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/a.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
            cjsSite({ sourceFile: '/root/apps/svc-a/b.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        const libEdges = result.edges.filter((e) => e.kind === 'lib-usage');
        expect(libEdges).toHaveLength(1);
        expect((libEdges[0]!.meta as Record<string, unknown>).importCount).toBe(2);
    });

    it('skips same-owner cjs-require (no lib-usage edge)', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [],
        );
        const sites: TsImportSite[] = [
            cjsSite({
                sourceFile: '/root/apps/svc-a/src/main.ts',
                specifier: './other',
                resolvedFile: '/root/apps/svc-a/src/other.ts',
            }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        const libEdges = result.edges.filter((e) => e.kind === 'lib-usage');
        expect(libEdges).toHaveLength(0);
        // resolvedToOwner still incremented (cross-file within same owner)
        expect(result.diagnostics.counts.resolvedToOwner).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// CJS require — non-resolved cases
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — cjs-require non-resolved', () => {
    it('dynamic-non-literal goes to cjsRequires (not unresolvedImports)', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'varName', kind: 'dynamic-non-literal' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.unresolvedImports).toHaveLength(0);
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
    });

    it('external cjs-require goes to cjsRequires, not unresolvedImports', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'lodash', kind: 'external' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.unresolvedImports).toHaveLength(0);
    });

    it('broken-relative cjs-require goes to cjsRequires AND unresolvedImports', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: './missing', kind: 'broken-relative' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.unresolvedImports).toHaveLength(1);
        expect(result.diagnostics.counts.unresolvedInternal).toBe(1);
    });

    it('broken-alias cjs-require goes to cjsRequires AND unresolvedImports', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: '@scope/missing', kind: 'broken-alias' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.unresolvedImports).toHaveLength(1);
        expect(result.diagnostics.counts.unresolvedInternal).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Static import mapping (verifying existing logic still works)
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — static sites', () => {
    it('resolved static import emits lib-usage', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.edges.some((e) => e.kind === 'lib-usage')).toBe(true);
        expect(result.diagnostics.counts.totalStatic).toBe(1);
        expect(result.diagnostics.counts.totalCjsRequire).toBe(0);
    });

    it('broken-relative static import goes to unresolvedImports', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: './missing', kind: 'broken-relative' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.unresolvedImports).toHaveLength(1);
    });

    it('broken-alias static import goes to unresolvedImports', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: '@scope/x', kind: 'broken-alias' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.unresolvedImports).toHaveLength(1);
    });

    it('external static import increments externalOrUnresolved', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'lodash', kind: 'external' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
    });

    it('source unknown (but target known) → increments externalOrUnresolved', () => {
        // Source is outside apps/libs, target IS owned — sourceOwner.kind === 'unknown' branch
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/random/main.ts', specifier: 'x', resolvedFile: '/root/apps/svc-a/src/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
    });

    it('both unknown → increments externalOrUnresolved', () => {
        const ownership = makeOwnership([], []);
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/random/main.ts', specifier: 'x', resolvedFile: '/root/other/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
    });

    it('exhaustiveness guard in default branch — fires on unknown resolution kind', () => {
        // Simulate a future resolution kind that is unknown to the switch.
        // We bypass TypeScript's discriminant check with a full `as any` cast.
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const badSite = {
            sourceFile: '/root/apps/svc-a/src/main.ts',
            specifier: 'x',
            resolution: { kind: 'totally-new-kind' },
            kind: 'static',
            typeOnly: false,
            specifierShape: 'bare-external',
            location: { file: '/root/apps/svc-a/src/main.ts', line: 1, column: 0 },
        } as unknown as TsImportSite;
        // Should not throw — routes to unresolvedInternal with a stderr warning
        const result = mapImportsToGraph([badSite], ownership, { fileLevel: false });
        expect(result.diagnostics.counts.unresolvedInternal).toBe(1);
    });

    it('target unknown → increments externalOrUnresolved', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/other/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
    });

    it('antipattern: service → service sets meta.antipattern', () => {
        const ownership = makeOwnership(
            [
                { id: 'svc-a', rootDir: '/root/apps/svc-a' },
                { id: 'svc-b', rootDir: '/root/apps/svc-b' },
            ],
            [],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/apps/svc-b/src/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        const libEdge = result.edges.find((e) => e.kind === 'lib-usage')!;
        expect((libEdge.meta as Record<string, unknown>).antipattern).toBe(true);
    });

    it('antipattern: lib → service sets meta.antipattern', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/libs/shared/index.ts', specifier: 'x', resolvedFile: '/root/apps/svc-a/src/main.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        const libEdge = result.edges.find((e) => e.kind === 'lib-usage')!;
        expect((libEdge.meta as Record<string, unknown>).antipattern).toBe(true);
    });

    it('non-antipattern: service → lib has no antipattern flag', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        const libEdge = result.edges.find((e) => e.kind === 'lib-usage')!;
        expect((libEdge.meta as Record<string, unknown>).antipattern).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Dynamic import mapping
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — dynamic sites', () => {
    it('dynamic resolved site emits lib-usage and increments totalDynamic', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            dynamicSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.totalDynamic).toBe(1);
        expect(result.diagnostics.dynamicImports).toHaveLength(1);
        expect(result.edges.some((e) => e.kind === 'lib-usage')).toBe(true);
    });

    it('dynamic non-literal site increments externalOrUnresolved', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            dynamicSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'varName', nonLiteral: true }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.externalOrUnresolved).toBe(1);
        expect(result.diagnostics.counts.totalDynamic).toBe(1);
    });

    it('file-level ts-import for dynamic site has meta.dynamic=true', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            dynamicSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: true });
        const fileEdge = result.edges.find((e) => e.kind === 'ts-import')!;
        expect(fileEdge.meta).toMatchObject({ dynamic: true });
    });
});

// ---------------------------------------------------------------------------
// File-level dedup
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — file-level edges dedup', () => {
    it('same file→file pair deduped into one ts-import edge', () => {
        const ownership = makeOwnership(
            [{ id: 'svc-a', rootDir: '/root/apps/svc-a' }],
            [{ id: 'libs/shared', rootDir: '/root/libs/shared' }],
        );
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'x', resolvedFile: '/root/libs/shared/index.ts' }),
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'y', resolvedFile: '/root/libs/shared/index.ts' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: true });
        const fileEdges = result.edges.filter((e) => e.kind === 'ts-import');
        expect(fileEdges).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Mixed sites — counts coherent
// ---------------------------------------------------------------------------

describe('mapImportsToGraph — mixed site types', () => {
    it('counts are independent across static, dynamic, cjs-require', () => {
        const ownership = makeOwnership([{ id: 'svc-a', rootDir: '/root/apps/svc-a' }], []);
        const sites: TsImportSite[] = [
            staticSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'a', kind: 'external' }),
            dynamicSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'b', nonLiteral: true }),
            cjsSite({ sourceFile: '/root/apps/svc-a/src/main.ts', specifier: 'c', kind: 'external' }),
        ];
        const result = mapImportsToGraph(sites, ownership, { fileLevel: false });
        expect(result.diagnostics.counts.totalStatic).toBe(1);
        expect(result.diagnostics.counts.totalDynamic).toBe(1);
        expect(result.diagnostics.counts.totalCjsRequire).toBe(1);
        expect(result.diagnostics.cjsRequires).toHaveLength(1);
        expect(result.diagnostics.dynamicImports).toHaveLength(1);
    });

    it('empty sites produces zero counts and empty arrays', () => {
        const ownership = makeOwnership([], []);
        const result = mapImportsToGraph([], ownership, { fileLevel: false });
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
        expect(result.diagnostics.counts.totalStatic).toBe(0);
        expect(result.diagnostics.counts.totalDynamic).toBe(0);
        expect(result.diagnostics.counts.totalCjsRequire).toBe(0);
        expect(result.diagnostics.cjsRequires).toHaveLength(0);
    });
});
