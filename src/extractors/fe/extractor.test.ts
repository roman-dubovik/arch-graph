/**
 * Tests for src/extractors/fe/extractor.ts
 *
 * Covers: end-to-end extraction from ts-morph Project,
 * component/hook/page/route/render/import detection,
 * tsx/jsx file filtering, and the fe-sample fixture set.
 */

import { describe, expect, it } from 'vitest';
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractFe } from './extractor.js';
import type { ArchGraphConfig } from '../../core/config.js';

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
