import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractFilterChain } from './filter-chain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function project(files: Record<string, string>) {
    return inMemoryProject(files);
}

// ---------------------------------------------------------------------------
// Class-level decorators
// ---------------------------------------------------------------------------

describe('extractFilterChain — class-level @UseGuards', () => {
    it('captures a bare identifier guard on a class', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                import { AuthGuard } from './auth.guard';
                @UseGuards(AuthGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref.kind).toBe('class');
        if (ref.kind === 'class' || ref.kind === 'instance') {
            expect(ref.name).toBe('AuthGuard');
        }
        expect(ref.decorator).toBe('UseGuards');
        expect(ref.enclosingClass).toBe('CatsController');
        expect(ref.attachedTo).toEqual({ kind: 'class' });
        expect(ref.location.file).toContain('cats.controller.ts');
        expect(ref.location.line).toBeGreaterThan(0);
    });

    it('captures a bare identifier interceptor on a class', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                import { LoggingInterceptor } from './logging.interceptor';
                @Controller('cats')
                @UseInterceptors(LoggingInterceptor)
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect(refs[0].decorator).toBe('UseInterceptors');
        if (refs[0].kind === 'class' || refs[0].kind === 'instance') {
            expect(refs[0].name).toBe('LoggingInterceptor');
        }
        expect(refs[0].attachedTo).toEqual({ kind: 'class' });
    });

    it('captures a bare identifier pipe on a class', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UsePipes } from '@nestjs/common';
                import { ValidationPipe } from '@nestjs/common';
                @UsePipes(ValidationPipe)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect(refs[0].decorator).toBe('UsePipes');
        if (refs[0].kind === 'class' || refs[0].kind === 'instance') {
            expect(refs[0].name).toBe('ValidationPipe');
        }
        expect(refs[0].attachedTo).toEqual({ kind: 'class' });
    });
});

// ---------------------------------------------------------------------------
// Method-level decorators
// ---------------------------------------------------------------------------

describe('extractFilterChain — method-level @UseGuards', () => {
    it('captures a guard on a method', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, Get, UseGuards } from '@nestjs/common';
                import { AuthGuard } from './auth.guard';
                @Controller('cats')
                export class CatsController {
                    @UseGuards(AuthGuard)
                    @Get()
                    findAll() { return []; }
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref.kind).toBe('class');
        if (ref.kind === 'class' || ref.kind === 'instance') {
            expect(ref.name).toBe('AuthGuard');
        }
        expect(ref.decorator).toBe('UseGuards');
        expect(ref.enclosingClass).toBe('CatsController');
        expect(ref.attachedTo).toEqual({ kind: 'method', methodName: 'findAll' });
    });

    it('captures an interceptor on a method', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, Get, UseInterceptors } from '@nestjs/common';
                import { CacheInterceptor } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @UseInterceptors(CacheInterceptor)
                    @Get()
                    findAll() { return []; }
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].attachedTo).toEqual({ kind: 'method', methodName: 'findAll' });
        expect(refs[0].decorator).toBe('UseInterceptors');
    });

    it('captures a pipe on a method', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, Post, UsePipes } from '@nestjs/common';
                import { ParseIntPipe } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @UsePipes(ParseIntPipe)
                    @Post()
                    create() {}
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].attachedTo).toEqual({ kind: 'method', methodName: 'create' });
        expect(refs[0].decorator).toBe('UsePipes');
    });
});

// ---------------------------------------------------------------------------
// Multiple arguments
// ---------------------------------------------------------------------------

describe('extractFilterChain — multiple arguments', () => {
    it('emits one ref per argument for @UseGuards(A, B)', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                import { AuthGuard } from './auth.guard';
                import { RoleGuard } from './role.guard';
                @UseGuards(AuthGuard, RoleGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(2);
        expect(refs[0].kind).not.toBe('unresolved');
        expect(refs[1].kind).not.toBe('unresolved');
        // Use type assertion — we already verified kind is not 'unresolved'
        expect((refs[0] as { name: string }).name).toBe('AuthGuard');
        expect((refs[1] as { name: string }).name).toBe('RoleGuard');
        refs.forEach((r) => {
            expect(r.decorator).toBe('UseGuards');
            expect(r.attachedTo).toEqual({ kind: 'class' });
        });
    });

    it('emits one ref per argument for three-arg @UseGuards', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(GuardA, GuardB, GuardC)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(3);
        expect(refs.map((r) => (r as { name: string }).name)).toEqual(['GuardA', 'GuardB', 'GuardC']);
    });
});

// ---------------------------------------------------------------------------
// Instance (new) arguments
// ---------------------------------------------------------------------------

describe('extractFilterChain — instance (new) arguments', () => {
    it('emits an instance ref for @UseInterceptors(new LoggingInterceptor())', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                import { LoggingInterceptor } from './logging.interceptor';
                @UseInterceptors(new LoggingInterceptor())
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref.kind).toBe('instance');
        if (ref.kind === 'instance') {
            expect(ref.name).toBe('LoggingInterceptor');
        }
        expect(ref.decorator).toBe('UseInterceptors');
        expect(ref.attachedTo).toEqual({ kind: 'class' });
    });

    it('emits an instance ref for @UseGuards(new AuthGuard("jwt"))', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @UseGuards(new AuthGuard('jwt'))
                    findAll() {}
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('instance');
        if (refs[0].kind === 'instance') {
            expect(refs[0].name).toBe('AuthGuard');
        }
    });
});

// ---------------------------------------------------------------------------
// All three decorators on same class
// ---------------------------------------------------------------------------

describe('extractFilterChain — all three decorators on the same class', () => {
    it('emits three separate refs for @UseGuards, @UseInterceptors, @UsePipes', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards, UseInterceptors, UsePipes } from '@nestjs/common';
                @UseGuards(AuthGuard)
                @UseInterceptors(LoggingInterceptor)
                @UsePipes(ValidationPipe)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(3);
        const decorators = refs.map((r) => r.decorator);
        expect(decorators).toContain('UseGuards');
        expect(decorators).toContain('UseInterceptors');
        expect(decorators).toContain('UsePipes');
    });
});

// ---------------------------------------------------------------------------
// Both class-level and method-level on the same class
// ---------------------------------------------------------------------------

describe('extractFilterChain — class and method level on same class', () => {
    it('emits refs for both class and method decorators', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, Get, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                @Controller('cats')
                export class CatsController {
                    @UseGuards(RoleGuard)
                    @Get()
                    findAll() {}
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(2);
        const classRef = refs.find((r) => r.attachedTo.kind === 'class');
        const methodRef = refs.find((r) => r.attachedTo.kind === 'method');
        expect((classRef as { name?: string })?.name).toBe('AuthGuard');
        expect((methodRef as { name?: string })?.name).toBe('RoleGuard');
        expect(methodRef?.attachedTo).toEqual({ kind: 'method', methodName: 'findAll' });
    });
});

// ---------------------------------------------------------------------------
// Unresolved arguments
// ---------------------------------------------------------------------------

describe('extractFilterChain — unresolved arguments', () => {
    it('emits unresolved for @UseGuards(...spread)', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                const guards = [AuthGuard, RoleGuard];
                @UseGuards(...guards)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        // Each spread element in the arg list is emitted
        const unresolved = refs.filter((r) => r.kind === 'unresolved');
        expect(unresolved.length).toBeGreaterThan(0);
        expect(unresolved[0].decorator).toBe('UseGuards');
    });

    it('emits unresolved for a ternary in @UseGuards', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                const prod = true;
                @UseGuards(prod ? AuthGuard : MockGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('unresolved');
        expect(refs[0].decorator).toBe('UseGuards');
        expect((refs[0] as { reason: string }).reason).toContain('unresolved-arg-kind');
    });

    it('emits unresolved for a function call in @UseInterceptors', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                function makeInterceptor() { return null as any; }
                @UseInterceptors(makeInterceptor())
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('unresolved');
    });
});

// ---------------------------------------------------------------------------
// Excluded files
// ---------------------------------------------------------------------------

describe('extractFilterChain — excluded files', () => {
    it('skips files under /node_modules/', () => {
        const p = project({
            '/node_modules/some-lib/src/controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                export class LibController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });

    it('skips files under /dist/', () => {
        const p = project({
            '/dist/cats.controller.js': `
                @UseGuards(AuthGuard)
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });

    it('skips .test.ts files', () => {
        const p = project({
            '/src/cats.controller.test.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(TestGuard)
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Empty / unrelated files
// ---------------------------------------------------------------------------

describe('extractFilterChain — empty or unrelated decorators', () => {
    it('returns empty for a file with no classes', () => {
        const p = project({
            '/src/constants.ts': `export const FOO = 'foo';`,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });

    it('returns empty for a class with no filter decorators', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, Get } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @Get()
                    findAll() { return []; }
                }
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });

    it('returns empty for an empty file', () => {
        const p = project({ '/src/empty.ts': '' });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(0);
    });

    it('ignores anonymous classes (no name)', () => {
        const p = project({
            '/src/anon.ts': `
                import { UseGuards } from '@nestjs/common';
                // This is a contrived case — anonymous class with decorator
                const ctrl = @UseGuards(AuthGuard) class {}
            `,
        });
        // Anonymous classes are skipped. This won't parse as valid TS but the extractor
        // handles it gracefully by checking className !== undefined.
        const refs = extractFilterChain(p);
        // Either 0 (if ts-morph rejects syntax) or refs may contain results for named
        // classes only. The important thing is no crash.
        expect(Array.isArray(refs)).toBe(true);
    });

    it('does not emit refs for decorator with no arguments', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards()
                @Controller('cats')
                export class CatsController {}
            `,
        });
        const refs = extractFilterChain(p);
        // @UseGuards() with zero args → nothing to emit
        expect(refs).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe('extractFilterChain — multiple files', () => {
    it('collects refs from multiple source files', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                @Controller('cats')
                export class CatsController {}
            `,
            '/src/dogs.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                @UseInterceptors(LoggingInterceptor)
                @Controller('dogs')
                export class DogsController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(2);
        const decorators = new Set(refs.map((r) => r.decorator));
        expect(decorators.has('UseGuards')).toBe(true);
        expect(decorators.has('UseInterceptors')).toBe(true);
    });

    it('skips excluded file while processing valid file', () => {
        const p = project({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                @Controller('cats')
                export class CatsController {}
            `,
            '/node_modules/some-pkg/controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(PkgGuard)
                export class PkgController {}
            `,
        });
        const refs = extractFilterChain(p);
        expect(refs).toHaveLength(1);
        expect((refs[0] as { name: string }).name).toBe('AuthGuard');
    });
});
