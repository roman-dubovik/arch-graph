/**
 * Tests for src/validation/fe-validator.ts
 *
 * Covers: buildFeReport recall metrics, empty/partial cases,
 * component/hook/route matching, ground truth with no matches,
 * enumerateFeGroundTruth against the fe-sample fixture directory.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Project, ts } from 'ts-morph';
import { buildFeReport, enumerateFeGroundTruth } from './fe-validator.js';
import { extractFe } from '../extractors/fe/extractor.js';
import type { FeExtractResult } from '../extractors/fe/types.js';
import type { FeGroundTruthEntry } from './fe-validator.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../__fixtures__/fe-sample');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyExtract(): FeExtractResult {
    return { components: [], hooks: [], routes: [], pages: [], renders: [], imports: [], unresolvedImports: [] };
}

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------
describe('buildFeReport — empty inputs', () => {
    it('returns recall 1 when both extracted and GT are empty', () => {
        const report = buildFeReport(emptyExtract(), []);
        expect(report.summary.recallComponents).toBe(1);
        expect(report.summary.recallRoutes).toBe(1);
        expect(report.summary.recallHooks).toBe(1);
    });

    it('returns recall 0 when GT has entries but extracted is empty', () => {
        const gt: FeGroundTruthEntry[] = [
            { role: 'component', file: '/app/Button.tsx', matchedText: 'const Button = () =>' },
            { role: 'hook', file: '/app/useX.ts', matchedText: 'useX' },
            { role: 'route', file: '/app/pages/index.tsx', matchedText: '/' },
        ];
        const report = buildFeReport(emptyExtract(), gt);
        expect(report.summary.recallComponents).toBe(0);
        expect(report.summary.recallHooks).toBe(0);
        expect(report.summary.recallRoutes).toBe(0);
        expect(report.missedComponents).toHaveLength(1);
        expect(report.missedHooks).toHaveLength(1);
        expect(report.missedRoutes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Component recall
// ---------------------------------------------------------------------------
describe('buildFeReport — component recall', () => {
    it('returns 1.0 recall when all components are extracted', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: '/app/Button.tsx', location: { file: '/app/Button.tsx', line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
        };
        const gt: FeGroundTruthEntry[] = [
            { role: 'component', file: '/app/Button.tsx', matchedText: 'const Button = () =>' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallComponents).toBe(1);
        expect(report.missedComponents).toHaveLength(0);
    });

    it('returns < 1.0 recall when a component is missed', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'Button', kind: 'arrow', file: '/app/Button.tsx', location: { file: '/app/Button.tsx', line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
        };
        const gt: FeGroundTruthEntry[] = [
            { role: 'component', file: '/app/Button.tsx', matchedText: 'const Button = () =>' },
            { role: 'component', file: '/app/Card.tsx', matchedText: 'function Card' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallComponents).toBe(0.5);
        expect(report.missedComponents).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Hook recall
// ---------------------------------------------------------------------------
describe('buildFeReport — hook recall', () => {
    it('returns 1.0 when all hooks extracted', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            hooks: [
                { name: 'useCounter', file: '/app/useCounter.ts', location: { file: '/app/useCounter.ts', line: 1, column: 0 } },
            ],
        };
        const gt: FeGroundTruthEntry[] = [
            { role: 'hook', file: '/app/useCounter.ts', matchedText: 'useCounter' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallHooks).toBe(1);
        expect(report.missedHooks).toHaveLength(0);
    });

    it('returns < 1.0 when hook is missed', () => {
        const extract: FeExtractResult = { ...emptyExtract() };
        const gt: FeGroundTruthEntry[] = [
            { role: 'hook', file: '/app/useCounter.ts', matchedText: 'useCounter' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallHooks).toBe(0);
        expect(report.missedHooks).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Route recall
// ---------------------------------------------------------------------------
describe('buildFeReport — route recall', () => {
    it('returns 1.0 when all routes extracted', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [
                { pattern: '/about', pageFile: '/app/pages/about.tsx' },
                { pattern: '/', pageFile: '/app/pages/index.tsx' },
            ],
        };
        const gt: FeGroundTruthEntry[] = [
            { role: 'route', file: '/app/pages/about.tsx', matchedText: '/about' },
            { role: 'route', file: '/app/pages/index.tsx', matchedText: '/' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallRoutes).toBe(1);
        expect(report.missedRoutes).toHaveLength(0);
    });

    it('returns < 1.0 when route is missed', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            routes: [{ pattern: '/about', pageFile: '/app/pages/about.tsx' }],
        };
        const gt: FeGroundTruthEntry[] = [
            { role: 'route', file: '/app/pages/about.tsx', matchedText: '/about' },
            { role: 'route', file: '/app/pages/users.tsx', matchedText: '/users' },
        ];
        const report = buildFeReport(extract, gt);
        expect(report.summary.recallRoutes).toBe(0.5);
        expect(report.missedRoutes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Summary totals
// ---------------------------------------------------------------------------
describe('buildFeReport — summary totals', () => {
    it('populates summary totals from extracted data', () => {
        const extract: FeExtractResult = {
            ...emptyExtract(),
            components: [
                { name: 'A', kind: 'arrow', file: '/a.tsx', location: { file: '/a.tsx', line: 1, column: 0 }, exported: true, defaultExport: false },
                { name: 'B', kind: 'function', file: '/b.tsx', location: { file: '/b.tsx', line: 1, column: 0 }, exported: true, defaultExport: false },
            ],
            hooks: [
                { name: 'useX', file: '/useX.ts', location: { file: '/useX.ts', line: 1, column: 0 } },
            ],
            routes: [{ pattern: '/', pageFile: '/pages/index.tsx' }],
        };
        const report = buildFeReport(extract, []);
        expect(report.summary.totalComponents).toBe(2);
        expect(report.summary.totalHooks).toBe(1);
        expect(report.summary.totalRoutes).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Ground truth passthrough
// ---------------------------------------------------------------------------
describe('buildFeReport — ground truth passthrough', () => {
    it('includes full GT in report', () => {
        const gt: FeGroundTruthEntry[] = [
            { role: 'component', file: '/app/A.tsx', matchedText: 'const A = () =>' },
        ];
        const report = buildFeReport(emptyExtract(), gt);
        expect(report.groundTruth).toEqual(gt);
    });
});

// ---------------------------------------------------------------------------
// enumerateFeGroundTruth — against real fe-sample fixtures
// ---------------------------------------------------------------------------
describe('enumerateFeGroundTruth — fe-sample fixtures', () => {
    const cfg = {
        id: 'fe-sample',
        root: FIXTURE_DIR,
        appsGlob: '**',
    };

    it('discovers component GT entries in .tsx files', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const components = gt.filter((g) => g.role === 'component');
        expect(components.length).toBeGreaterThan(0);
    });

    it('discovers hook GT entries', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const hooks = gt.filter((g) => g.role === 'hook');
        // fe-sample has useCounter and useFetch
        expect(hooks.length).toBeGreaterThan(0);
        expect(hooks.some((h) => h.matchedText === 'useCounter')).toBe(true);
    });

    it('does not count bare use* utilities as hook GT entries', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-fe-gt-'));
        try {
            await writeFile(
                join(dir, 'usePureFn.ts'),
                `export function usePureFn() { return 42; }\nexport const useRealHook = () => useMemo(() => 42, []);\n`,
                'utf8',
            );

            const gt = await enumerateFeGroundTruth({ id: 'tmp', root: dir, appsGlob: '**' });
            const hooks = gt.filter((g) => g.role === 'hook').map((g) => g.matchedText);
            expect(hooks).toContain('useRealHook');
            expect(hooks).not.toContain('usePureFn');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('discovers route GT entries', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const routes = gt.filter((g) => g.role === 'route');
        // pages/index.tsx → /, pages/users/[id].tsx → /users/:id
        expect(routes.some((r) => r.matchedText === '/')).toBe(true);
        expect(routes.some((r) => r.matchedText === '/users/:id')).toBe(true);
    });

    it('skips _app.tsx from route GT', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const routes = gt.filter((g) => g.role === 'route');
        expect(routes.every((r) => !r.file.includes('_app'))).toBe(true);
    });

    it('skips api/ routes from route GT', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const routes = gt.filter((g) => g.role === 'route');
        expect(routes.every((r) => !r.file.includes('/api/'))).toBe(true);
    });

    it('includes app router routes', async () => {
        const gt = await enumerateFeGroundTruth(cfg);
        const routes = gt.filter((g) => g.role === 'route');
        // app/users/[id]/page.tsx → /users/:id
        const appRoutes = routes.filter((r) => r.file.includes('/app/'));
        expect(appRoutes.length).toBeGreaterThan(0);
    });

    it('works with libsGlob set', async () => {
        const cfgWithLibs = { ...cfg, libsGlob: 'src/components' };
        const gt = await enumerateFeGroundTruth(cfgWithLibs);
        expect(gt.length).toBeGreaterThan(0);
    });

    it('honors excludeGlobs so validator and extractor use the same source set', async () => {
        const gt = await enumerateFeGroundTruth({ ...cfg, excludeGlobs: ['/src/hooks/'] });
        const hooks = gt.filter((g) => g.role === 'hook');
        expect(hooks.every((h) => !h.file.includes('/src/hooks/'))).toBe(true);
    });

    it('handles ENOENT gracefully (no crash)', async () => {
        // cfg pointing to a root with no files — fg returns []
        const emptyCfg = { id: 'empty', root: '/nonexistent-dir-xyz', appsGlob: '**' };
        // Should not throw
        const gt = await enumerateFeGroundTruth(emptyCfg);
        expect(Array.isArray(gt)).toBe(true);
    });

    it('processes .tsx file with no JSX (isFE=true, JSX_RE.test=false)', async () => {
        // typeUtils.tsx is a .tsx file with no JSX — exercises the !JSX_RE.test branch
        const gt = await enumerateFeGroundTruth(cfg);
        // Should not throw; any hooks in typeUtils.tsx would be picked up
        expect(Array.isArray(gt)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// End-to-end integration: extractFe → buildFeReport against fe-sample fixture
// (P1 test gap #2: no e2e test linking extractor output to validator report)
//
// Uses in-memory Project seeded from real fixture contents to avoid the
// /.worktrees/ path exclusion in isExcludedSourceFile while testing real data.
// ---------------------------------------------------------------------------

/** Recursively collect all .ts/.tsx files under a directory. */
async function collectFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...await collectFiles(full));
        else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) results.push(full);
    }
    return results;
}

/**
 * Build an in-memory ts-morph Project seeded with real fe-sample fixture contents.
 * Virtual paths strip the worktrees prefix, returning { project, virtualRoot }
 * where virtualRoot is the synthetic root used for cfg.root.
 */
async function buildFeSampleInMemoryProject(): Promise<{ project: Project; virtualRoot: string }> {
    const files = await collectFiles(FIXTURE_DIR);
    const virtualRoot = '/fe-sample-root';
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, noEmit: true, jsx: ts.JsxEmit.React },
    });
    for (const file of files) {
        const rel = file.slice(FIXTURE_DIR.length);
        project.createSourceFile(`${virtualRoot}${rel}`, await readFile(file, 'utf8'));
    }
    return { project, virtualRoot };
}

describe('extractFe → buildFeReport integration against fe-sample', () => {
    it('achieves ≥ 0.9 component recall against fe-sample', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const fixtureCfg = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const extracted = await extractFe(fixtureCfg, project);
        const gt = await enumerateFeGroundTruth({ id: 'fe-sample', root: FIXTURE_DIR, appsGlob: '**' });
        // Remap GT file paths to virtual paths for comparison
        const virtualGt = gt.map((g) => ({ ...g, file: virtualRoot + g.file.slice(FIXTURE_DIR.length) }));
        const report = buildFeReport(extracted, virtualGt);
        expect(report.summary.recallComponents).toBeGreaterThanOrEqual(0.9);
    });

    it('achieves ≥ 0.9 route recall against fe-sample', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const fixtureCfg = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const extracted = await extractFe(fixtureCfg, project);
        const gt = await enumerateFeGroundTruth({ id: 'fe-sample', root: FIXTURE_DIR, appsGlob: '**' });
        const report = buildFeReport(extracted, gt); // routes match by pattern, not file
        expect(report.summary.recallRoutes).toBeGreaterThanOrEqual(0.9);
    });

    it('achieves ≥ 0.9 hook recall against fe-sample', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const fixtureCfg = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const extracted = await extractFe(fixtureCfg, project);
        const gt = await enumerateFeGroundTruth({ id: 'fe-sample', root: FIXTURE_DIR, appsGlob: '**' });
        const virtualGt = gt.map((g) => ({ ...g, file: virtualRoot + g.file.slice(FIXTURE_DIR.length) }));
        const report = buildFeReport(extracted, virtualGt);
        expect(report.summary.recallHooks).toBeGreaterThanOrEqual(0.9);
    });
});
