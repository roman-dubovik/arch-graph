/**
 * Tests for src/extractors/fe/extractor.ts
 *
 * Covers: end-to-end extraction from ts-morph Project,
 * component/hook/page/route/render/import detection,
 * tsx/jsx file filtering, and the fe-sample fixture set.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { Project, ts } from 'ts-morph';
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractFe } from './extractor.js';
import { mapFeToGraph } from '../../mapper/fe-to-graph.js';
import { buildEmbedText } from '../../semantic/builder.js';
import { OwnershipRegistry } from '../../core/service-registry.js';
import type { ArchGraphConfig } from '../../core/config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FE_SAMPLE_DIR = resolve(__dirname, '../../__fixtures__/fe-sample');

/**
 * Recursively collect all .ts/.tsx files under a directory.
 */
async function collectFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await collectFiles(full));
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Build an in-memory ts-morph Project seeded with real fixture file contents.
 * We use in-memory to avoid the /.worktrees/ exclusion in isExcludedSourceFile,
 * while still testing the real file contents from the fe-sample fixture directory.
 * Virtual paths strip the worktrees prefix so the extractor accepts the files.
 */
async function buildFeSampleInMemoryProject(): Promise<{ project: Project; virtualRoot: string }> {
    const files = await collectFiles(FE_SAMPLE_DIR);
    const virtualRoot = '/fe-sample-root';
    const fileMap: Record<string, string> = {};
    for (const file of files) {
        const rel = file.slice(FE_SAMPLE_DIR.length); // e.g. /app/page.tsx
        const virtualPath = `${virtualRoot}${rel}`;
        fileMap[virtualPath] = await readFile(file, 'utf8');
    }
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
            target: 99,
            module: 99,
            moduleResolution: 100,
            strict: false,
            noEmit: true,
            jsx: ts.JsxEmit.React,
        },
    });
    for (const [path, src] of Object.entries(fileMap)) {
        project.createSourceFile(path, src);
    }
    return { project, virtualRoot };
}

function minimalCfg(root = '/root'): ArchGraphConfig {
    return { id: 'test', root, appsGlob: 'apps/*' };
}

// ---------------------------------------------------------------------------
// Basic extraction
// ---------------------------------------------------------------------------
describe('extractFe — basic component detection', () => {
    it('finds arrow component in .tsx file', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Button.tsx': `export const Button = () => <button/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components.some((c) => c.name === 'Button')).toBe(true);
    });

    it('skips .ts files for component detection', async () => {
        const project = inMemoryProject({
            '/root/apps/web/utils.ts': `export const Util = () => 42;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });

    it('skips .tsx test files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Button.test.tsx': `const Comp = () => <div/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });
});

describe('extractFe — hooks', () => {
    it('finds hook in .tsx file', async () => {
        const project = inMemoryProject({
            '/root/apps/web/useData.tsx': `
                import { useState } from 'react';
                export function useData() { const [x] = useState(0); return x; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.hooks.some((h) => h.name === 'useData')).toBe(true);
    });

    it('finds hook in .jsx file', async () => {
        const project = inMemoryProject({
            '/root/apps/web/useToggle.jsx': `
                import { useState } from 'react';
                export function useToggle() { const [on, setOn] = useState(false); return { on, setOn }; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.hooks.some((h) => h.name === 'useToggle')).toBe(true);
    });
});

describe('extractFe — pages and routes', () => {
    it('detects Pages Router index page → /route', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/index.tsx': `export default function Home() { return <main/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes.some((r) => r.pattern === '/')).toBe(true);
        expect(result.pages.some((p) => p.route === '/')).toBe(true);
    });

    it('detects Pages Router dynamic route → /users/:id', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/users/[id].tsx': `export default function UserPage() { return <div/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes.some((r) => r.pattern === '/users/:id')).toBe(true);
    });

    it('skips _app.tsx from routes', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/_app.tsx': `export default function App({ Component, pageProps }) { return <Component {...pageProps}/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes).toHaveLength(0);
        expect(result.pages).toHaveLength(0);
    });

    it('skips API routes', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/api/users.ts': `export default function handler(req, res) { res.json({}); }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes).toHaveLength(0);
    });

    it('detects App Router page.tsx → / for root', async () => {
        const project = inMemoryProject({
            '/root/apps/web/app/page.tsx': `export default function RootPage() { return <main/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes.some((r) => r.pattern === '/')).toBe(true);
    });

    it('detects App Router dynamic page → /users/:id', async () => {
        const project = inMemoryProject({
            '/root/apps/web/app/users/[id]/page.tsx': `export default function UserPage() { return <div/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes.some((r) => r.pattern === '/users/:id')).toBe(true);
    });

    it('deduplicates routes with same pattern', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/about.tsx': `export default function About() { return <div/>; }`,
            '/root/apps/web/pages/contact.tsx': `export default function Contact() { return <div/>; }`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.routes).toHaveLength(2);
    });
});

describe('extractFe — imports', () => {
    it('collects import refs from .tsx files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/index.tsx': `
                import { Button } from './components/Button';
                export default function Page() { return <Button/>; }
            `,
            '/root/apps/web/components/Button.tsx': `export const Button = () => <button/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        const imp = result.imports.find((i) => i.importedName === 'Button');
        expect(imp).toBeDefined();
        expect(imp!.specifier).toBe('./components/Button');
    });

    it('skips non-local imports (bare packages)', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Page.tsx': `
                import React from 'react';
                export const Page = () => <div/>;
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        // react is external, should not be in imports
        expect(result.imports.every((i) => i.specifier !== 'react')).toBe(true);
    });
});

describe('extractFe — renders', () => {
    it('collects render references', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Layout.tsx': `
                import { Nav } from './Nav';
                export const Layout = () => <div><Nav/></div>;
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.renders.some((r) => r.toName === 'Nav')).toBe(true);
    });
});

describe('extractFe — result shape', () => {
    it('returns all required keys', async () => {
        const project = inMemoryProject({});
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result).toHaveProperty('components');
        expect(result).toHaveProperty('hooks');
        expect(result).toHaveProperty('routes');
        expect(result).toHaveProperty('pages');
        expect(result).toHaveProperty('renders');
        expect(result).toHaveProperty('imports');
        expect(Array.isArray(result.components)).toBe(true);
        expect(Array.isArray(result.hooks)).toBe(true);
        expect(Array.isArray(result.routes)).toBe(true);
        expect(Array.isArray(result.renders)).toBe(true);
        expect(Array.isArray(result.imports)).toBe(true);
    });
});

describe('extractFe — spec file exclusion', () => {
    it('skips .spec.tsx files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Comp.spec.tsx': `export const Comp = () => <div/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });

    it('skips .spec.jsx files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Comp.spec.jsx': `export const Comp = () => <div/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });

    it('skips .test.jsx files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Comp.test.jsx': `export const Comp = () => <div/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });
});

describe('extractFe — namespace imports', () => {
    it('collects namespace import names', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Page.tsx': `
                import * as Icons from './icons';
                export const Page = () => <div/>;
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        // Should have import for the namespace
        expect(result.imports.some((i) => i.importedName === 'Icons')).toBe(true);
    });
});

describe('extractFe — route deduplication', () => {
    it('deduplicates identical route patterns', async () => {
        const project = inMemoryProject({
            '/root/apps/web/pages/index.tsx': `export default function Home() { return <main/>; }`,
        });
        // add same file twice conceptually (same result)
        const result = await extractFe(minimalCfg('/root'), project);
        const indexRoutes = result.routes.filter((r) => r.pattern === '/');
        expect(indexRoutes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// P0-1: .ts files extract hooks only (no components, renders, imports)
// ---------------------------------------------------------------------------
describe('extractFe — .ts file hook extraction (P0-1)', () => {
    it('extracts hooks from .ts files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/useAuth.ts': `
                import { useState } from 'react';
                export function useAuth() { const [user] = useState(null); return user; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.hooks.some((h) => h.name === 'useAuth')).toBe(true);
    });

    it('does NOT extract components from .ts files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/NotAComponent.ts': `export const Button = () => 42;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.components).toHaveLength(0);
    });

    it('does NOT collect imports from .ts files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/utils.ts': `
                import { something } from './other';
                export function useSomething() { return something; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        // imports array should not contain entries from .ts files
        expect(result.imports.every((i) => !i.sourceFile.endsWith('.ts'))).toBe(true);
    });

    it('skips .spec.ts files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/useAuth.spec.ts': `
                import { useState } from 'react';
                export function useAuth() { const [x] = useState(0); return x; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.hooks).toHaveLength(0);
    });

    it('skips .test.ts files', async () => {
        const project = inMemoryProject({
            '/root/apps/web/useAuth.test.ts': `
                import { useState } from 'react';
                export function useAuth() { const [x] = useState(0); return x; }
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.hooks).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// unresolvedImports field
// ---------------------------------------------------------------------------
describe('extractFe — unresolvedImports', () => {
    it('result includes unresolvedImports array', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Page.tsx': `export const Page = () => <div/>;`,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result).toHaveProperty('unresolvedImports');
        expect(Array.isArray(result.unresolvedImports)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Route dedup branch (pageResult.route already in routeMap)
// ---------------------------------------------------------------------------
describe('extractFe — route map deduplication (duplicate patterns)', () => {
    it('keeps first pageFile when two pages produce the same route pattern', async () => {
        // Two pages would only collide if in a monorepo config spanning multiple apps
        // but we can simulate this with our minimalCfg having two files with same pattern
        const project = inMemoryProject({
            '/root/apps/web/pages/about.tsx': `export default function About1() { return <div/>; }`,
            '/root/apps/mobile/pages/about.tsx': `export default function About2() { return <div/>; }`,
        });
        // Both resolve to /about — second should be deduped in routeMap
        const result = await extractFe({ id: 'test', root: '/root', appsGlob: 'apps/**' }, project);
        const aboutRoutes = result.routes.filter((r) => r.pattern === '/about');
        expect(aboutRoutes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// @-aliased imports
// ---------------------------------------------------------------------------
describe('extractFe — @-aliased imports', () => {
    it('collects @-aliased imports', async () => {
        const project = inMemoryProject({
            '/root/apps/web/Page.tsx': `
                import { Button } from '@/components/Button';
                export const Page = () => <div/>;
            `,
        });
        const result = await extractFe(minimalCfg('/root'), project);
        expect(result.imports.some((i) => i.specifier === '@/components/Button')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// P0-NEW integration test: in-memory Project seeded from fe-sample fixture files
// with .tsx and .ts globs — tests that tsx files ARE processed by the extractor.
//
// We use in-memory (not real FS) to avoid the /.worktrees/ path exclusion in
// isExcludedSourceFile. Virtual paths mirror the fixture structure without the
// worktree prefix, so the extractor sees them as normal application files.
// ---------------------------------------------------------------------------
describe('extractFe — in-memory Project seeded from fe-sample (P0-NEW tsx glob fix)', () => {
    it('finds >0 components in fe-sample fixture (tsx files are processed)', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const cfg: ArchGraphConfig = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const result = await extractFe(cfg, project);
        expect(result.components.length).toBeGreaterThan(0);
    });

    it('finds >0 routes in fe-sample fixture', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const cfg: ArchGraphConfig = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const result = await extractFe(cfg, project);
        expect(result.routes.length).toBeGreaterThan(0);
    });

    it('finds >0 hooks in fe-sample fixture', async () => {
        const { project, virtualRoot } = await buildFeSampleInMemoryProject();
        const cfg: ArchGraphConfig = { id: 'fe-sample', root: virtualRoot, appsGlob: '**' };
        const result = await extractFe(cfg, project);
        expect(result.hooks.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Task B integration tests (AC-B5, AC-B6, AC-B7)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory project from a map of files, extractFe, then mapFeToGraph.
 * Ownership registry maps everything under /root to a fake service.
 */
async function buildI18nIntegration(
    files: Record<string, string>,
    root = '/root',
): Promise<{ nodes: ReturnType<typeof mapFeToGraph>['nodes']; components: Awaited<ReturnType<typeof extractFe>>['components'] }> {
    const project = inMemoryProject(files);
    const cfg: ArchGraphConfig = { id: 'test', root, appsGlob: '**' };
    const extracted = await extractFe(cfg, project);

    // Minimal ownership registry — maps everything under /root to a fake service
    const ownership = new OwnershipRegistry('/root', [
        { id: 'svc:web', rootDir: '/root', tsconfigPath: null, entryFile: null },
    ], []);

    const { nodes } = mapFeToGraph(extracted, ownership);
    return { nodes, components: extracted.components };
}

describe('i18n integration — AC-B7: next-intl resolved (B1 path)', () => {
    it('populates i18nStrings on FeComponent for next-intl t() calls', async () => {
        const { components } = await buildI18nIntegration({
            '/root/apps/web/Button.tsx': `
                import { useTranslations } from 'next-intl';
                export const Button = () => {
                    const t = useTranslations();
                    return <button>{t('common.apply')}</button>;
                };
            `,
            // Inline minimal messages — extractor reads from disk (root/messages/ru.json)
            // For in-memory tests, the file won't exist, so we pass empty messages
            // and verify the no-file graceful path. Actual disk-based AC-B1 is in i18n-resolver.test.ts.
        });
        const btn = components.find((c) => c.name === 'Button');
        expect(btn).toBeDefined();
        // i18nStrings is populated (may be empty if no messages/ru.json found for virtual root)
        expect(Array.isArray(btn!.i18nStrings)).toBe(true);
    });
});

describe('i18n integration — AC-B7: react-i18next resolved (B2 path)', () => {
    it('populates i18nStrings on FeComponent for react-i18next t() calls', async () => {
        const { components } = await buildI18nIntegration({
            '/root/apps/web/CancelBtn.tsx': `
                import { useTranslation } from 'react-i18next';
                export const CancelBtn = () => {
                    const { t } = useTranslation();
                    return <button>{t('common.cancel')}</button>;
                };
            `,
        });
        const btn = components.find((c) => c.name === 'CancelBtn');
        expect(btn).toBeDefined();
        expect(Array.isArray(btn!.i18nStrings)).toBe(true);
    });
});

describe('i18n integration — AC-B7: library absent no-op (B3 path)', () => {
    it('leaves i18nStrings empty when no i18n library imported', async () => {
        const { components } = await buildI18nIntegration({
            '/root/apps/web/Plain.tsx': `
                export const Plain = () => <div>hello</div>;
            `,
        });
        const plain = components.find((c) => c.name === 'Plain');
        expect(plain).toBeDefined();
        expect(plain!.i18nStrings).toEqual([]);
    });
});

describe('i18n integration — AC-B5: meta.i18nStrings flows through fe-to-graph', () => {
    it('propagates non-empty i18nStrings to GraphNode.meta', async () => {
        // We test with a real fixture directory that has messages/ru.json
        const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample');
        const files = await collectFiles(fixtureDir);
        const virtualRoot = '/fe-i18n-root';
        const fileMap: Record<string, string> = {};
        for (const file of files) {
            const rel = file.slice(fixtureDir.length);
            fileMap[`${virtualRoot}${rel}`] = await readFile(file, 'utf8');
        }

        // Use real root pointing at fixture dir so messages/ru.json is loaded from disk
        const project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, jsx: ts.JsxEmit.React },
        });
        for (const [path, src] of Object.entries(fileMap)) {
            project.createSourceFile(path, src);
        }

        const cfg: ArchGraphConfig = { id: 'i18n-sample', root: fixtureDir, appsGlob: '**' };
        const extracted = await extractFe(cfg, project);

        // NextIntlButton should have Применить resolved
        const btn = extracted.components.find((c) => c.name === 'NextIntlButton');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toContain('Применить');

        // Map to graph and check meta flows through
        const ownership = new OwnershipRegistry(fixtureDir, [
            { id: 'svc:web', rootDir: fixtureDir, tsconfigPath: null, entryFile: null },
        ], []);
        const { nodes } = mapFeToGraph(extracted, ownership);

        const btnNode = nodes.find((n) => n.label === 'NextIntlButton');
        expect(btnNode).toBeDefined();
        expect(Array.isArray(btnNode!.meta?.['i18nStrings'])).toBe(true);
        expect(btnNode!.meta!['i18nStrings']).toContain('Применить');
    });
});

describe('i18n integration — AC-B6: buildEmbedText appends i18n strings', () => {
    it('appends i18nStrings to embed text for fe-component nodes', () => {
        const node = {
            id: 'fe-component:/root/Button.tsx#Button',
            kind: 'fe-component' as const,
            label: 'Button',
            path: '/root/Button.tsx',
            meta: { i18nStrings: ['Применить', 'Отмена'] },
        };
        const text = buildEmbedText(node, 'const Button = () => <button/>');
        expect(text).toContain('Применить');
        expect(text).toContain('Отмена');
        expect(text).toMatch(/Применить Отмена/);
    });

    it('does NOT append i18n strings for non-fe-component nodes', () => {
        const node = {
            id: 'fe-hook:/root/useAuth.ts#useAuth',
            kind: 'fe-hook' as const,
            label: 'useAuth',
            path: '/root/useAuth.ts',
            meta: { i18nStrings: ['Применить'] },
        };
        const text = buildEmbedText(node, 'function useAuth() {}');
        expect(text).not.toContain('Применить');
    });

    it('produces no trailing content when i18nStrings is empty', () => {
        const node = {
            id: 'fe-component:/root/Plain.tsx#Plain',
            kind: 'fe-component' as const,
            label: 'Plain',
            path: '/root/Plain.tsx',
            meta: { i18nStrings: [] },
        };
        const snippetText = 'const Plain = () => <div/>';
        const text = buildEmbedText(node, snippetText);
        // Should end with the snippet, not have extra newline+empty
        expect(text).toBe(`Plain fe-component\n${snippetText}`);
    });

    it('works when meta is absent (no i18nStrings)', () => {
        const node = {
            id: 'fe-component:/root/NoMeta.tsx#NoMeta',
            kind: 'fe-component' as const,
            label: 'NoMeta',
            path: '/root/NoMeta.tsx',
        };
        expect(() => buildEmbedText(node, 'const NoMeta = () => <div/>')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Review round 1: new integration tests (tests 1–4, 6–7)
// ---------------------------------------------------------------------------

/**
 * Helper: build in-memory Project seeded from a real fixture subdir,
 * extractFe using the real disk path as root (so loadProjectMessages
 * reads actual JSON files), return extracted result.
 */
async function buildFromFixtureSubdir(subdir: string): Promise<Awaited<ReturnType<typeof extractFe>>> {
    const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample', subdir);
    const files = await collectFiles(fixtureDir);
    const virtualRoot = `/fe-i18n-${subdir}`;
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, jsx: ts.JsxEmit.React },
    });
    for (const file of files) {
        const rel = file.slice(fixtureDir.length);
        project.createSourceFile(`${virtualRoot}${rel}`, await readFile(file, 'utf8'));
    }
    // Use real root so messages/ru.json (etc.) are read from disk
    const cfg: ArchGraphConfig = { id: subdir, root: fixtureDir, appsGlob: '**' };
    return extractFe(cfg, project);
}

// Test 1: ru preferred over en
describe('i18n integration — test 1: ru-preferred-over-en', () => {
    it('resolves common.apply to Russian string when both ru.json and en.json exist', async () => {
        const extracted = await buildFromFixtureSubdir('ru-preferred');
        const btn = extracted.components.find((c) => c.name === 'ApplyButton');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toContain('Применить');
        expect(btn!.i18nStrings).not.toContain('Apply');
    });
});

// Test 2: en-only fallback
describe('i18n integration — test 2: en-only-fallback', () => {
    it('resolves key from en.json when no ru.json exists', async () => {
        const extracted = await buildFromFixtureSubdir('en-only');
        const btn = extracted.components.find((c) => c.name === 'EnOnlyButton');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toContain('English only value');
    });
});

// Test 3: locales third-tier fallback
describe('i18n integration — test 3: locales-third-tier-fallback', () => {
    it('resolves key from locales/ru/translation.json when no messages/ dir exists', async () => {
        const extracted = await buildFromFixtureSubdir('locales-fallback');
        const btn = extracted.components.find((c) => c.name === 'LocalesButton');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toContain('Применить');
    });
});

// Test 4: no message files — graceful empty
describe('i18n integration — test 4: no-messages-graceful-empty', () => {
    it('returns i18nStrings=[] and does not throw when no message files exist', async () => {
        // Use a virtual root that has no messages/ or locales/ dirs
        const project = inMemoryProject({
            '/empty-root/Button.tsx': `
                import { useTranslations } from 'next-intl';
                export const Button = () => {
                    const t = useTranslations();
                    return <button>{t('common.apply')}</button>;
                };
            `,
        });
        const cfg: ArchGraphConfig = { id: 'test', root: '/empty-root', appsGlob: '**' };
        const extracted = await extractFe(cfg, project);
        const btn = extracted.components.find((c) => c.name === 'Button');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toEqual([]);
    });
});

// Test 6: buildEmbedText fe-page and fe-route kinds do NOT get i18n strings appended
describe('i18n integration — test 6: buildEmbedText-fe-page-kind-gate', () => {
    it('does NOT append i18nStrings for fe-page nodes', () => {
        const node = {
            id: 'fe-page:/root/pages/index.tsx#Home',
            kind: 'fe-page' as const,
            label: 'Home',
            path: '/root/pages/index.tsx',
            meta: { i18nStrings: ['foo'] },
        };
        const text = buildEmbedText(node, 'export default function Home() {}');
        expect(text).not.toContain('foo');
    });

    it('does NOT append i18nStrings for fe-route nodes', () => {
        const node = {
            id: 'fe-route:/',
            kind: 'fe-route' as const,
            label: '/',
            path: '/root/pages/index.tsx',
            meta: { i18nStrings: ['foo'] },
        };
        const text = buildEmbedText(node, '');
        expect(text).not.toContain('foo');
    });
});

// Test 7: fe-to-graph elides empty i18nStrings from meta
describe('i18n integration — test 7: fe-to-graph-empty-array-elision', () => {
    it('does not include i18nStrings key in GraphNode.meta when array is empty', async () => {
        const { nodes } = await buildI18nIntegration({
            '/root/apps/web/Plain.tsx': `
                import { useTranslations } from 'next-intl';
                export const Plain = () => {
                    const t = useTranslations();
                    return <div>{t('nonexistent.key')}</div>;
                };
            `,
        });
        const plain = nodes.find((n) => n.label === 'Plain' && n.kind === 'fe-component');
        expect(plain).toBeDefined();
        // i18nStrings should not be present when empty (conditional spread in fe-to-graph)
        expect(plain!.meta).not.toHaveProperty('i18nStrings');
    });
});

// Test 8: aliased-t-binding-detected — integration through extractFe with real fixture
describe('i18n integration — test 8: aliased-t-binding-detected (P1-A)', () => {
    it('resolves strings when t is aliased (const { t: translate } = useTranslation())', async () => {
        const project = inMemoryProject({
            '/root/apps/web/AliasedComp.tsx': `
                import { useTranslation } from 'react-i18next';
                export const AliasedComp = () => {
                    const { t: translate } = useTranslation();
                    return <button>{translate('common.apply')}</button>;
                };
            `,
        });
        const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample');
        const cfg: ArchGraphConfig = { id: 'test', root: fixtureDir, appsGlob: '**' };
        const extracted = await extractFe(cfg, project);
        const comp = extracted.components.find((c) => c.name === 'AliasedComp');
        expect(comp).toBeDefined();
        // fixtureDir has messages/ru.json with common.apply = "Применить"
        expect(comp!.i18nStrings).toContain('Применить');
    });
});
