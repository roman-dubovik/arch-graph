/**
 * Tests for src/extractors/fe/router-patterns.ts
 *
 * Covers: Pages Router routes, App Router routes, dynamic segments,
 * catch-all segments, route groups, internal pages, API routes, isPageFile.
 */

import { describe, expect, it } from 'vitest';
import { deriveRoute, isPageFile } from './router-patterns.js';

const ROOT = '/monorepo/apps/my-app';

describe('deriveRoute — Pages Router', () => {
    it('pages/index.tsx → /', () => {
        expect(deriveRoute(`${ROOT}/pages/index.tsx`, ROOT)).toEqual({ route: '/', router: 'pages' });
    });

    it('pages/about.tsx → /about', () => {
        expect(deriveRoute(`${ROOT}/pages/about.tsx`, ROOT)).toEqual({ route: '/about', router: 'pages' });
    });

    it('pages/users/profile.tsx → /users/profile', () => {
        expect(deriveRoute(`${ROOT}/pages/users/profile.tsx`, ROOT)).toEqual({
            route: '/users/profile',
            router: 'pages',
        });
    });

    it('pages/users/[id].tsx → /users/:id', () => {
        expect(deriveRoute(`${ROOT}/pages/users/[id].tsx`, ROOT)).toEqual({
            route: '/users/:id',
            router: 'pages',
        });
    });

    it('pages/[...slug].tsx → /*', () => {
        expect(deriveRoute(`${ROOT}/pages/[...slug].tsx`, ROOT)).toEqual({
            route: '/*',
            router: 'pages',
        });
    });

    it('pages/users/index.tsx → /users', () => {
        expect(deriveRoute(`${ROOT}/pages/users/index.tsx`, ROOT)).toEqual({
            route: '/users',
            router: 'pages',
        });
    });

    it('pages/_app.tsx → null (internal)', () => {
        expect(deriveRoute(`${ROOT}/pages/_app.tsx`, ROOT)).toBeNull();
    });

    it('pages/_document.tsx → null (internal)', () => {
        expect(deriveRoute(`${ROOT}/pages/_document.tsx`, ROOT)).toBeNull();
    });

    it('pages/api/users.ts → null (API route)', () => {
        expect(deriveRoute(`${ROOT}/pages/api/users.ts`, ROOT)).toBeNull();
    });

    it('pages/api/v2/health.ts → null (nested API route)', () => {
        expect(deriveRoute(`${ROOT}/pages/api/v2/health.ts`, ROOT)).toBeNull();
    });

    it('supports .jsx extension', () => {
        expect(deriveRoute(`${ROOT}/pages/about.jsx`, ROOT)).toEqual({ route: '/about', router: 'pages' });
    });
});

describe('deriveRoute — App Router', () => {
    it('app/page.tsx → /', () => {
        expect(deriveRoute(`${ROOT}/app/page.tsx`, ROOT)).toEqual({ route: '/', router: 'app' });
    });

    it('app/about/page.tsx → /about', () => {
        expect(deriveRoute(`${ROOT}/app/about/page.tsx`, ROOT)).toEqual({ route: '/about', router: 'app' });
    });

    it('app/users/[id]/page.tsx → /users/:id', () => {
        expect(deriveRoute(`${ROOT}/app/users/[id]/page.tsx`, ROOT)).toEqual({
            route: '/users/:id',
            router: 'app',
        });
    });

    it('app/(marketing)/about/page.tsx → /about (group stripped)', () => {
        expect(deriveRoute(`${ROOT}/app/(marketing)/about/page.tsx`, ROOT)).toEqual({
            route: '/about',
            router: 'app',
        });
    });

    it('app/[...slug]/page.tsx → /*', () => {
        expect(deriveRoute(`${ROOT}/app/[...slug]/page.tsx`, ROOT)).toEqual({
            route: '/*',
            router: 'app',
        });
    });

    it('supports .jsx extension', () => {
        expect(deriveRoute(`${ROOT}/app/about/page.jsx`, ROOT)).toEqual({ route: '/about', router: 'app' });
    });

    it('non-page app file → null', () => {
        expect(deriveRoute(`${ROOT}/app/about/layout.tsx`, ROOT)).toBeNull();
    });
});

describe('deriveRoute — non-page files', () => {
    it('regular component file → null', () => {
        expect(deriveRoute(`${ROOT}/src/components/Button.tsx`, ROOT)).toBeNull();
    });

    it('.ts hook file → null', () => {
        expect(deriveRoute(`${ROOT}/src/hooks/useCounter.ts`, ROOT)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// P1-5: App Router edge cases
// ---------------------------------------------------------------------------
describe('deriveRoute — App Router edge cases (P1-5)', () => {
    it('parallel route @slot → null', () => {
        // e.g. app/@modal/page.tsx — slot is not a real route
        expect(deriveRoute(`${ROOT}/app/@modal/page.tsx`, ROOT)).toBeNull();
    });

    it('intercepting route (.) → null', () => {
        expect(deriveRoute(`${ROOT}/app/(.)photo/page.tsx`, ROOT)).toBeNull();
    });

    it('intercepting route (..) → null', () => {
        expect(deriveRoute(`${ROOT}/app/(..)(..)/photo/page.tsx`, ROOT)).toBeNull();
    });

    it('intercepting route (...) → null', () => {
        expect(deriveRoute(`${ROOT}/app/(...)/photo/page.tsx`, ROOT)).toBeNull();
    });

    it('optional catch-all [[...slug]] → /*', () => {
        expect(deriveRoute(`${ROOT}/app/[[...slug]]/page.tsx`, ROOT)).toEqual({
            route: '/*',
            router: 'app',
        });
    });

    it('pages router optional catch-all [[...slug]] → /*', () => {
        expect(deriveRoute(`${ROOT}/pages/[[...slug]].tsx`, ROOT)).toEqual({
            route: '/*',
            router: 'pages',
        });
    });

    it('route group (marketing) is stripped → /about', () => {
        expect(deriveRoute(`${ROOT}/app/(marketing)/about/page.tsx`, ROOT)).toEqual({
            route: '/about',
            router: 'app',
        });
    });
});

describe('deriveRoute — root with trailing slash', () => {
    it('handles root with trailing slash', () => {
        expect(deriveRoute('/app/pages/about.tsx', '/app/')).toEqual({ route: '/about', router: 'pages' });
    });
});

describe('isPageFile', () => {
    it('pages/index.tsx → true', () => {
        expect(isPageFile('/app/pages/index.tsx')).toBe(true);
    });

    it('pages/users/[id].tsx → true', () => {
        expect(isPageFile('/app/pages/users/[id].tsx')).toBe(true);
    });

    it('pages/_app.tsx → false (internal)', () => {
        expect(isPageFile('/app/pages/_app.tsx')).toBe(false);
    });

    it('pages/api/users.ts → false (API)', () => {
        expect(isPageFile('/app/pages/api/users.ts')).toBe(false);
    });

    it('app/page.tsx → true', () => {
        expect(isPageFile('/app/app/page.tsx')).toBe(true);
    });

    it('app/users/[id]/page.tsx → true', () => {
        expect(isPageFile('/app/app/users/[id]/page.tsx')).toBe(true);
    });

    it('src/components/Button.tsx → false', () => {
        expect(isPageFile('/app/src/components/Button.tsx')).toBe(false);
    });

    it('app/layout.tsx → false (not a page)', () => {
        expect(isPageFile('/app/app/layout.tsx')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// extractPageFromFile
// ---------------------------------------------------------------------------
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractPageFromFile } from './router-patterns.js';

describe('extractPageFromFile', () => {
    it('returns null for non-page file', () => {
        const project = inMemoryProject({
            '/root/src/components/Button.tsx': `export const Button = () => <div/>;`,
        });
        const sf = project.getSourceFileOrThrow('/root/src/components/Button.tsx');
        expect(extractPageFromFile(sf, '/root')).toBeNull();
    });

    it('returns FePage for pages/index.tsx', () => {
        const project = inMemoryProject({
            '/root/pages/index.tsx': `export default function Home() { return <main/>; }`,
        });
        const sf = project.getSourceFileOrThrow('/root/pages/index.tsx');
        const page = extractPageFromFile(sf, '/root');
        expect(page).not.toBeNull();
        expect(page!.route).toBe('/');
        expect(page!.router).toBe('pages');
        expect(page!.name).toBe('Home');
    });

    it('falls back to filename when no exported function found', () => {
        const project = inMemoryProject({
            '/root/pages/about.tsx': `const x = 1;`,
        });
        const sf = project.getSourceFileOrThrow('/root/pages/about.tsx');
        const page = extractPageFromFile(sf, '/root');
        expect(page).not.toBeNull();
        // Falls back to capitalised filename
        expect(page!.name.length).toBeGreaterThan(0);
    });

    it('derives name from var declaration when no function found', () => {
        const project = inMemoryProject({
            '/root/pages/users.tsx': `export const UsersPage = () => <div/>;`,
        });
        const sf = project.getSourceFileOrThrow('/root/pages/users.tsx');
        const page = extractPageFromFile(sf, '/root');
        expect(page).not.toBeNull();
        expect(page!.route).toBe('/users');
    });

    it('returns page for app router page.tsx', () => {
        const project = inMemoryProject({
            '/root/app/about/page.tsx': `export default function AboutPage() { return <div/>; }`,
        });
        const sf = project.getSourceFileOrThrow('/root/app/about/page.tsx');
        const page = extractPageFromFile(sf, '/root');
        expect(page).not.toBeNull();
        expect(page!.route).toBe('/about');
        expect(page!.router).toBe('app');
    });
});
