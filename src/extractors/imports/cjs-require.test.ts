/**
 * Tests for CJS require() extraction in src/extractors/imports/extractor.ts.
 *
 * Strategy: use in-memory ts-morph Projects for most cases. Alias-resolver
 * tests that exercise `buildAliasResolver` (which reads from real disk via
 * node:fs) are driven via real temp directories.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Project } from 'ts-morph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ArchGraphConfig } from '../../core/config.js';
import { extractImports } from './extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inMemoryProject(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: true },
    });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}

/** Minimal config pointing at a fake root — alias resolution won't fire when no tsconfig exists. */
function minimalCfg(root = '/src'): ArchGraphConfig {
    return {
        root,
        appsGlob: 'apps/*',
        libsGlob: 'libs/*',
        imports: { fileLevel: false },
    } as unknown as ArchGraphConfig;
}

// ---------------------------------------------------------------------------
// CJS require — basic cases (in-memory FS, no alias resolver)
// ---------------------------------------------------------------------------

describe('CJS require extraction — basic', () => {
    it('captures a bare relative require with string literal arg', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require('./foo');`,
            '/src/foo.ts': `export const foo = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifier).toBe('./foo');
        expect(cjsSites[0]!.typeOnly).toBe(false);
        expect(cjsSites[0]!.specifierShape).toBe('relative');
    });

    it('captures a side-effect require with no destructuring', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `require('./logger');`,
            '/src/logger.ts': `export default function log() {}`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifier).toBe('./logger');
    });

    it('captures an external (bare) require', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const _ = require('lodash');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifier).toBe('lodash');
        expect(cjsSites[0]!.specifierShape).toBe('bare-external');
        expect(cjsSites[0]!.resolution.kind).toBe('external');
    });

    it('captures a node: builtin require', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const fs = require('node:fs');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifierShape).toBe('builtin');
        expect(cjsSites[0]!.resolution).toEqual({ kind: 'external', packageName: 'node:fs' });
    });

    it('captures non-literal require as dynamic-non-literal', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require(varName);`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution.kind).toBe('dynamic-non-literal');
        expect(cjsSites[0]!.specifierShape).toBe('bare-external');
    });

    it('skips require.resolve — not a bare require identifier', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const p = require.resolve('./foo');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(0);
    });

    it('skips obj.require(...) — method call not bare require', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = obj.require('foo');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(0);
    });

    it('skips file with no require( substring — fast path', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `export const x = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        expect(sites).toHaveLength(0);
    });

    it('handles CJS-only files (no import keyword) via updated fast-path', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const fs = require('node:fs');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        // Must not be filtered out even though there's no "import" substring
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
    });

    it('captures missing relative require as broken-relative', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require('./missing');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution.kind).toBe('broken-relative');
    });

    it('includes location (line/column) on the captured site', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require('./foo');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.location).toMatchObject({
            file: '/src/a.ts',
            line: expect.any(Number),
            column: expect.any(Number),
        });
    });

    it('captures multiple require calls in the same file', async () => {
        const project = inMemoryProject({
            '/src/a.ts': [
                `const fs = require('node:fs');`,
                `const path = require('node:path');`,
                `const x = require('./local');`,
            ].join('\n'),
            '/src/local.ts': 'export const local = 1;',
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(3);
    });

    it('handles await require (mixed code) — still emits site', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `async function f() { const x = await require('./foo'); }`,
            '/src/foo.ts': `export const foo = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifier).toBe('./foo');
    });

    it('handles no-substitution template literal arg', async () => {
        const project = inMemoryProject({
            '/src/a.ts': 'const x = require(`lodash`);',
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifier).toBe('lodash');
        expect(cjsSites[0]!.resolution.kind).toBe('external');
    });

    it('skips require with zero arguments', async () => {
        // `require()` with no args is invalid but syntactically parses
        const project = inMemoryProject({
            '/src/a.ts': `const x = require();`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(0);
    });

    it('skips require with multiple arguments', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require('./foo', 'extra');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(0);
    });

    it('does not produce cjs-require sites for import declarations', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `import { foo } from './foo'; const x = 1;`,
            '/src/foo.ts': `export const foo = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const staticSites = sites.filter((s) => s.kind === 'static');
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(staticSites).toHaveLength(1);
        expect(cjsSites).toHaveLength(0);
    });

    it('coexists with static import in same file', async () => {
        const project = inMemoryProject({
            '/src/a.ts': [
                `import { readFile } from 'node:fs/promises';`,
                `const x = require('lodash');`,
            ].join('\n'),
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const staticSites = sites.filter((s) => s.kind === 'static');
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(staticSites).toHaveLength(1);
        expect(cjsSites).toHaveLength(1);
    });

    it('scoped package require yields bare-external shape', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const common = require('@nestjs/common');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution).toEqual({ kind: 'external', packageName: '@nestjs/common' });
        expect(cjsSites[0]!.specifierShape).toBe('bare-external');
    });

    it('specifier with sub-path extracts canonical package name', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `const x = require('@nestjs/common/decorators');`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution).toEqual({ kind: 'external', packageName: '@nestjs/common' });
    });
});

// ---------------------------------------------------------------------------
// Alias resolver tests — require temp dir on real FS
// ---------------------------------------------------------------------------

describe('CJS require extraction — alias resolver', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'arch-graph-cjs-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(rel: string, content: string): string {
        const abs = join(tmpDir, rel);
        mkdirSync(join(tmpDir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(abs, content);
        return abs;
    }

    function realProject(files: Record<string, string>): Project {
        // We need ts-morph to NOT use the in-memory FS so that the
        // alias resolver (which calls existsSync/readFileSync) can find
        // the real files we created in tmpDir.
        const project = new Project({
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: true },
        });
        for (const [rel, src] of Object.entries(files)) {
            const abs = writeFile(rel, src);
            project.addSourceFileAtPath(abs);
        }
        return project;
    }

    it('resolves alias require when tsconfig.base.json has paths', async () => {
        // Create alias target file
        writeFile('libs/messaging/src/index.ts', 'export const msg = 1;');
        // Create tsconfig with alias
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@scope/messaging': ['libs/messaging/src/index.ts'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@scope/messaging');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifierShape).toBe('alias');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('emits broken-alias when alias prefix matched but file not found', async () => {
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@scope/missing': ['libs/missing/src/index.ts'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@scope/missing');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution.kind).toBe('broken-alias');
    });

    it('resolves wildcard alias path require', async () => {
        writeFile('libs/ui/src/components/Button.ts', 'export const Button = null;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@ui/*': ['libs/ui/src/*'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@ui/components/Button');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.specifierShape).toBe('alias');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('falls through to external when no tsconfig is found', async () => {
        // No tsconfig at tmpDir root
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@scope/messaging');`,
        });
        const cfg = minimalCfg(tmpDir);
        // Should warn on stderr but not throw
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        // Without tsconfig paths, alias-shaped specifiers fall through to external
        expect(cjsSites[0]!.resolution.kind).toBe('external');
    });

    it('uses tsconfig.json as fallback when base is absent', async () => {
        writeFile('libs/core/src/index.ts', 'export const core = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@core': ['libs/core/src/index.ts'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@core');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('handles JSONC comments in tsconfig.base.json', async () => {
        writeFile('libs/core/src/index.ts', 'export const core = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            `{
  // This is a comment
  "compilerOptions": {
    /* block comment */
    "paths": {
      "@core": ["libs/core/src/index.ts"] // inline comment
    }
  }
}`,
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@core');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('handles trailing commas in tsconfig.base.json', async () => {
        writeFile('libs/core/src/index.ts', 'export const core = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            `{
  "compilerOptions": {
    "paths": {
      "@core": ["libs/core/src/index.ts"],
    },
  },
}`,
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@core');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('unreadable tsconfig.base.json emits warning and tries tsconfig.json fallback', async () => {
        // Create an unreadable tsconfig.base.json (chmod 000)
        const tsconfigBase = join(tmpDir, 'tsconfig.base.json');
        writeFileSync(tsconfigBase, JSON.stringify({ compilerOptions: {} }));
        // Make it unreadable
        const { chmodSync } = await import('node:fs');
        chmodSync(tsconfigBase, 0o000);
        try {
            // Create a fallback tsconfig.json
            writeFile('libs/fallback/src/index.ts', 'export const f = 1;');
            writeFileSync(
                join(tmpDir, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        paths: { '@fallback': ['libs/fallback/src/index.ts'] },
                    },
                }),
            );
            const project = realProject({
                'apps/svc/src/main.ts': `const x = require('@fallback');`,
            });
            const cfg = minimalCfg(tmpDir);
            // Should not throw; falls through to tsconfig.json
            const { sites } = await extractImports(cfg, project);
            const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
            expect(cjsSites).toHaveLength(1);
            // Resolved via tsconfig.json fallback
            expect(cjsSites[0]!.resolution.kind).toBe('resolved');
        } finally {
            // Restore permissions so afterEach cleanup can delete
            chmodSync(tsconfigBase, 0o644);
        }
    });

    it('tsconfig with no compilerOptions.paths falls through silently', async () => {
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({ compilerOptions: {} }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('lodash');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('external');
    });

    it('sorts path entries longest-key-first when multiple aliases exist', async () => {
        // Need 2+ path entries so the sort comparator (a, b) => b[0].length - a[0].length fires.
        writeFile('libs/a/src/index.ts', 'export const a = 1;');
        writeFile('libs/ab/src/index.ts', 'export const ab = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        '@scope/a': ['libs/a/src/index.ts'],
                        '@scope/ab-longer-key': ['libs/ab/src/index.ts'],
                    },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@scope/a');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites).toHaveLength(1);
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('isAliasPrefix returns false when specifier does not match any path prefix', async () => {
        // Tsconfig has @ui/* prefix but we require @other/pkg — no match → external
        writeFile('libs/ui/src/components/Button.ts', 'export const B = null;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@ui/*': ['libs/ui/src/*'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@other/pkg');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        // @other/pkg is not an alias — falls through to external
        expect(cjsSites[0]!.resolution.kind).toBe('external');
        expect(cjsSites[0]!.specifierShape).toBe('bare-external');
    });

    it('malformed JSON in tsconfig.base.json emits warning and continues', async () => {
        // tsconfig.base.json has malformed JSON even after comment/comma stripping
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            `{ "compilerOptions": { "paths": { INVALID JSON } } }`,
        );
        // Fallback tsconfig.json with valid JSON
        writeFile('libs/core/src/index.ts', 'export const core = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    paths: { '@core': ['libs/core/src/index.ts'] },
                },
            }),
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@core');`,
        });
        const cfg = minimalCfg(tmpDir);
        // Should not throw — falls through to tsconfig.json
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        // Either resolves from tsconfig.json or falls through to external
        expect(cjsSites).toHaveLength(1);
    });

    it('handles string with escape sequences in JSONC tsconfig', async () => {
        // String values with escape sequences (\n, \\, etc.) must not confuse
        // the stripTrailingCommas and stripJsonComments parsers.
        writeFile('libs/core/src/index.ts', 'export const core = 1;');
        writeFileSync(
            join(tmpDir, 'tsconfig.base.json'),
            // JSON with actual string escapes in a comment value field
            `{
  "compilerOptions": {
    "tsNote": "line1\\nline2",
    "paths": {
      "@core": ["libs/core/src/index.ts"]
    }
  }
}`,
        );
        const project = realProject({
            'apps/svc/src/main.ts': `const x = require('@core');`,
        });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// Static import extraction (to ensure we didn't break existing logic)
// ---------------------------------------------------------------------------

describe('Static import extraction — smoke', () => {
    it('captures a static import', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `import { foo } from './foo';`,
            '/src/foo.ts': `export const foo = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const staticSites = sites.filter((s) => s.kind === 'static');
        expect(staticSites).toHaveLength(1);
        expect(staticSites[0]!.specifier).toBe('./foo');
        expect(staticSites[0]!.typeOnly).toBe(false);
    });

    it('captures a type-only static import', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `import type { Foo } from './foo';`,
            '/src/foo.ts': `export interface Foo {}`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const staticSites = sites.filter((s) => s.kind === 'static');
        expect(staticSites[0]!.typeOnly).toBe(true);
    });

    it('marks broken-relative for missing static import target', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `import { x } from './missing';`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        expect(sites[0]!.resolution.kind).toBe('broken-relative');
    });

    it('marks external for npm packages', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `import { Injectable } from '@nestjs/common';`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        expect(sites[0]!.resolution).toEqual({ kind: 'external', packageName: '@nestjs/common' });
    });
});

// ---------------------------------------------------------------------------
// Dynamic import extraction
// ---------------------------------------------------------------------------

describe('Dynamic import extraction — smoke', () => {
    it('captures a literal dynamic import', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `async function f() { const x = await import('./foo'); }`,
            '/src/foo.ts': `export const foo = 1;`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const dynSites = sites.filter((s) => s.kind === 'dynamic');
        expect(dynSites).toHaveLength(1);
        expect(dynSites[0]!.specifier).toBe('./foo');
    });

    it('captures a non-literal dynamic import as dynamic-non-literal', async () => {
        const project = inMemoryProject({
            '/src/a.ts': `async function f() { const x = await import(varName); }`,
        });
        const cfg = minimalCfg('/src');
        const { sites } = await extractImports(cfg, project);
        const dynSites = sites.filter((s) => s.kind === 'dynamic');
        expect(dynSites).toHaveLength(1);
        expect(dynSites[0]!.resolution.kind).toBe('dynamic-non-literal');
    });
});

// ---------------------------------------------------------------------------
// Probe helpers — real FS tests via temp dirs
// ---------------------------------------------------------------------------

describe('probeRelative — extension and index probing', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'arch-graph-probe-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeRealFile(rel: string, content = 'export const x = 1;'): string {
        const abs = join(tmpDir, rel);
        mkdirSync(abs.split('/').slice(0, -1).join('/'), { recursive: true });
        writeFileSync(abs, content);
        return abs;
    }

    function realProject(files: Record<string, string>): Project {
        const project = new Project({
            compilerOptions: { target: 99, module: 99, moduleResolution: 100, strict: true },
        });
        for (const [rel, src] of Object.entries(files)) {
            const abs = writeRealFile(rel, src);
            project.addSourceFileAtPath(abs);
        }
        return project;
    }

    it('resolves .ts extension file', async () => {
        writeRealFile('libs/bar.ts');
        const project = realProject({ 'apps/a.ts': `const x = require('../libs/bar');` });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('resolves .tsx extension file', async () => {
        writeRealFile('libs/comp.tsx');
        const project = realProject({ 'apps/a.ts': `const x = require('../libs/comp');` });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('resolves index.ts in directory', async () => {
        writeRealFile('libs/pkg/index.ts');
        const project = realProject({ 'apps/a.ts': `const x = require('../libs/pkg');` });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('resolves index.tsx in directory', async () => {
        writeRealFile('libs/pkg/index.tsx');
        const project = realProject({ 'apps/a.ts': `const x = require('../libs/pkg');` });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('resolved');
    });

    it('emits broken-relative when directory has no index file', async () => {
        // Create an empty directory — no index.*
        mkdirSync(join(tmpDir, 'apps'), { recursive: true });
        mkdirSync(join(tmpDir, 'libs/emptydir'), { recursive: true });
        const project = realProject({ 'apps/a.ts': `const x = require('../libs/emptydir');` });
        const cfg = minimalCfg(tmpDir);
        const { sites } = await extractImports(cfg, project);
        const cjsSites = sites.filter((s) => s.kind === 'cjs-require');
        expect(cjsSites[0]!.resolution.kind).toBe('broken-relative');
    });
});
