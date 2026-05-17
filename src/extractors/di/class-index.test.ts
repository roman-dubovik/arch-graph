/**
 * Tests for the buildClassIndex production entry-point (P0-2).
 *
 * Exercises: first-seen-wins on duplicate class names (alphabetic path order),
 * node_modules exclusion, and empty project.
 */
import { describe, expect, it } from 'vitest';
import { Project, ts } from 'ts-morph';

import { buildClassIndex } from './class-index.js';

function inMemoryProject(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
            target: 99,
            module: 99,
            moduleResolution: 100,
            strict: false,
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
        },
    });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}

describe('buildClassIndex', () => {
    it('P0-2a: empty project → idx.size === 0', () => {
        const project = inMemoryProject({});
        const idx = buildClassIndex(project);
        expect(idx.size()).toBe(0);
    });

    it('P0-2b: first-seen-wins on duplicate class name (alphabetic path sort)', () => {
        // /aaa/foo.ts sorts before /zzz/foo.ts, so /aaa/foo.ts should win.
        const project = inMemoryProject({
            '/zzz/foo.ts': `export class MyService {}`,
            '/aaa/foo.ts': `export class MyService {}`,
        });
        const idx = buildClassIndex(project);
        expect(idx.size()).toBe(1);
        expect(idx.get('MyService')).toBe('/aaa/foo.ts');
    });

    it('P0-2c: files under node_modules/ are excluded', () => {
        const project = inMemoryProject({
            'node_modules/some-lib/lib.ts': `export class LibService {}`,
            '/apps/api/src/app.ts': `export class AppService {}`,
        });
        const idx = buildClassIndex(project);
        // LibService from node_modules must not be indexed
        expect(idx.has('LibService')).toBe(false);
        // AppService from project source must be indexed
        expect(idx.has('AppService')).toBe(true);
    });

    it('indexes multiple distinct classes from multiple files', () => {
        const project = inMemoryProject({
            '/apps/api/src/a.ts': `export class ServiceA {}`,
            '/apps/api/src/b.ts': `export class ServiceB {}`,
        });
        const idx = buildClassIndex(project);
        expect(idx.size()).toBe(2);
        expect(idx.get('ServiceA')).toBe('/apps/api/src/a.ts');
        expect(idx.get('ServiceB')).toBe('/apps/api/src/b.ts');
    });
});
