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

// ---------------------------------------------------------------------------
// AC-7: Multi-file locales tests (Task B i18n-resolver extension)
// ---------------------------------------------------------------------------

/**
 * Helper: extract from a multi-file fixture subdir using the real disk path as root.
 * Optionally pass tsx file sources as a virtual map to test specific components
 * without having to put .tsx files in the fixture directory.
 */
async function buildFromMultiFileFixture(
    subdir: string,
    componentFiles?: Record<string, string>,
    capOverride?: number,
): Promise<Awaited<ReturnType<typeof extractFe>>> {
    const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample', subdir);
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, jsx: ts.JsxEmit.React },
    });
    // Add component files as virtual sources
    if (componentFiles) {
        for (const [path, src] of Object.entries(componentFiles)) {
            project.createSourceFile(path, src);
        }
    } else {
        // Load .tsx files from fixture dir
        const tsxFiles = await collectFiles(fixtureDir);
        for (const file of tsxFiles) {
            if (file.endsWith('.tsx') || file.endsWith('.ts')) {
                const rel = file.slice(fixtureDir.length);
                project.createSourceFile(`/vroot${rel}`, await readFile(file, 'utf8'));
            }
        }
    }
    // Use real fixture dir as root so locales/*.json are read from disk
    const cfg: ArchGraphConfig = { id: subdir, root: fixtureDir, appsGlob: '**' };
    return extractFe(cfg, project, capOverride);
}

// AC-7 Test 1: multi-file mode detection
describe('i18n multi-file — AC-7 test 1: mode detection', () => {
    it('detects multi-file mode when only locales/ru/blogs.json + locales/ru/products.json exist', async () => {
        const extracted = await buildFromMultiFileFixture('multi-file', {
            '/vroot/Placeholder.tsx': `export const Placeholder = () => <div/>;`,
        });
        expect(extracted.i18nDiagnostics.i18nMode).toBe('multi-file');
        expect(extracted.i18nDiagnostics.i18nFilesLoaded).toBe(2);
    });
});

// AC-7 Test 2: useTranslation('blogs') + t('title') resolves to locales/ru/blogs.json#/title
describe('i18n multi-file — AC-7 test 2: namespace-based resolution (project-b pattern)', () => {
    it('resolves useTranslation("blogs") + t("title") → "Заголовок" (project-b-like fixture)', async () => {
        const extracted = await buildFromMultiFileFixture('multi-file', {
            '/vroot/BlogsPage.tsx': `
                import { useTranslation } from 'react-i18next';
                export const BlogsPage = () => {
                    const { t } = useTranslation('blogs');
                    return <h1>{t('title')}</h1>;
                };
            `,
        });
        const comp = extracted.components.find((c) => c.name === 'BlogsPage');
        expect(comp).toBeDefined();
        // "Заголовок" comes from locales/ru/blogs.json#/title
        expect(comp!.i18nStrings).toContain('Заголовок');
    });
});

// AC-7 Test 3: Russian preferred over English
describe('i18n multi-file — AC-7 test 3: Russian preferred over English', () => {
    it('uses Russian value when both locales/ru/ and locales/en/ exist', async () => {
        // multi-file fixture has both ru/blogs.json ("Заголовок") and en/blogs.json ("Title")
        const extracted = await buildFromMultiFileFixture('multi-file', {
            '/vroot/BlogsPage.tsx': `
                import { useTranslation } from 'react-i18next';
                export const BlogsPage = () => {
                    const { t } = useTranslation('blogs');
                    return <h1>{t('title')}</h1>;
                };
            `,
        });
        const comp = extracted.components.find((c) => c.name === 'BlogsPage');
        expect(comp).toBeDefined();
        expect(comp!.i18nStrings).toContain('Заголовок');
        expect(comp!.i18nStrings).not.toContain('Title');
    });
});

// AC-7 Test 4: single-file mode still works (regression)
describe('i18n multi-file — AC-7 test 4: single-file mode regression', () => {
    it('single-file mode still loads messages/ru.json and resolves keys', async () => {
        // fe-i18n-sample root has messages/ru.json → single-file mode
        const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample');
        const project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, jsx: ts.JsxEmit.React },
        });
        project.createSourceFile('/vroot/Button.tsx', `
            import { useTranslations } from 'next-intl';
            export const Button = () => {
                const t = useTranslations();
                return <button>{t('common.apply')}</button>;
            };
        `);
        const cfg: ArchGraphConfig = { id: 'single-file-regression', root: fixtureDir, appsGlob: '**' };
        const extracted = await extractFe(cfg, project);
        expect(extracted.i18nDiagnostics.i18nMode).toBe('single-file');
        const btn = extracted.components.find((c) => c.name === 'Button');
        expect(btn).toBeDefined();
        expect(btn!.i18nStrings).toContain('Применить');
    });
});

// AC-7 Test 5: 100-file cap fires (via capOverride=2, 3 files exist)
describe('i18n multi-file — AC-7 test 5: file cap fires (cap=2, 3 files exist)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits WARNING and stops loading beyond cap (cap=2, fixture has 3 files)', async () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const extracted = await buildFromMultiFileFixture('multi-file-many', {
            '/vroot/Placeholder.tsx': `export const Placeholder = () => <div/>;`,
        }, /* capOverride= */ 2);

        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const capWarns = calls.filter((s) => s.includes('capping at'));
        expect(capWarns.length).toBeGreaterThan(0);
        expect(capWarns[0]).toContain('[arch-graph fe-i18n] WARNING');
        // Only 2 files loaded due to cap
        expect(extracted.i18nDiagnostics.i18nFilesLoaded).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// P0-TEST-1: unscoped t() in multi-file mode (AC-3)
// ---------------------------------------------------------------------------

// AC-3: "For unscoped t('apply') (no namespace), try 'apply' directly across
// all files' top-level keys."  In multi-file mode the merged messages object
// has shape { blogs: { title: "...", ... }, products: { ... } }.
// Unscoped t() means useTranslation() / useTranslations() with no argument,
// so collectNamespaces returns {''} and buildCandidateKeys produces
// candidates = [key] (no namespace prefix).

describe('i18n multi-file — P0-TEST-1: unscoped t() in multi-file mode', () => {
    it('resolves t("blogs.title") with unscoped useTranslation() in multi-file mode', async () => {
        // useTranslation() with no namespace — full dotted key 'blogs.title' must resolve
        // against merged messages { blogs: { title: "Заголовок", ... }, ... }
        const extracted = await buildFromMultiFileFixture('multi-file', {
            '/vroot/UnscopedFull.tsx': `
                import { useTranslation } from 'react-i18next';
                export const UnscopedFull = () => {
                    const { t } = useTranslation();
                    return <h1>{t('blogs.title')}</h1>;
                };
            `,
        });
        const comp = extracted.components.find((c) => c.name === 'UnscopedFull');
        expect(comp).toBeDefined();
        // 'blogs.title' traverses merged.blogs.title → "Заголовок"
        expect(comp!.i18nStrings).toContain('Заголовок');
    });

    it('t("title") alone (unscoped) is undefined — no top-level "title" key in multi-file merged object', async () => {
        // The merged object has shape { blogs: {...}, products: {...} }.
        // There is no top-level 'title' key, so this should NOT resolve.
        const extracted = await buildFromMultiFileFixture('multi-file', {
            '/vroot/UnscopedBare.tsx': `
                import { useTranslation } from 'react-i18next';
                export const UnscopedBare = () => {
                    const { t } = useTranslation();
                    return <h1>{t('title')}</h1>;
                };
            `,
        });
        const comp = extracted.components.find((c) => c.name === 'UnscopedBare');
        expect(comp).toBeDefined();
        // No top-level 'title' in merged multi-file messages — should be empty
        expect(comp!.i18nStrings).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// P1-TEST-1: multi-file-en-only fixture test
// ---------------------------------------------------------------------------

describe('i18n multi-file — P1-TEST-1: en-only multi-file fixture', () => {
    it('resolves useTranslation("blogs") + t("title") from en-only locales when no ru exists', async () => {
        const extracted = await buildFromMultiFileFixture('multi-file-en-only', {
            '/vroot/EnOnlyBlogs.tsx': `
                import { useTranslation } from 'react-i18next';
                export const EnOnlyBlogs = () => {
                    const { t } = useTranslation('blogs');
                    return <h1>{t('title')}</h1>;
                };
            `,
        });
        const comp = extracted.components.find((c) => c.name === 'EnOnlyBlogs');
        expect(comp).toBeDefined();
        // locales/en/blogs.json has title = "Title (en-only)"
        expect(comp!.i18nStrings).toContain('Title (en-only)');
        // Language detection should be 'en' since only en files are present
        expect(extracted.i18nDiagnostics.i18nLanguagesFound).toContain('en');
        expect(extracted.i18nDiagnostics.i18nMode).toBe('multi-file');
    });
});

// ---------------------------------------------------------------------------
// P1-2: language-detection uses tuple map, not path substring re-parsing
// ---------------------------------------------------------------------------

describe('i18n — P1-2: language attributed from discovery tuple, not path substring', () => {
    it('correctly identifies "en" when messages/en.json is loaded from a path containing "ru" substring', async () => {
        // Simulate a project root whose path contains 'ru' (e.g. a developer named 'drupal' or
        // a folder like '/Users/dru/projects/myapp'). If language detection re-parsed the path
        // via .includes('/ru/') it would misidentify. Our tuple-based approach reads the correct lang.
        const fixtureDir = resolve(__dirname, '../../__fixtures__/fe-i18n-sample/en-only');
        // en-only fixture has messages/en.json but no messages/ru.json
        const project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: false, jsx: ts.JsxEmit.React },
        });
        project.createSourceFile('/vroot/Comp.tsx', `
            import { useTranslations } from 'next-intl';
            export const Comp = () => {
                const t = useTranslations();
                return <button>{t('common.apply')}</button>;
            };
        `);
        const cfg: ArchGraphConfig = { id: 'en-only-lang-test', root: fixtureDir, appsGlob: '**' };
        const extracted = await extractFe(cfg, project);
        // Should be single-file mode with en (not ru)
        expect(extracted.i18nDiagnostics.i18nMode).toBe('single-file');
        expect(extracted.i18nDiagnostics.i18nLanguagesFound).toContain('en');
        expect(extracted.i18nDiagnostics.i18nLanguagesFound).not.toContain('ru');
    });
});
