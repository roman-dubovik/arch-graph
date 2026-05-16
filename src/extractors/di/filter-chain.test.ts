import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';
import { extractFilterChain } from './filter-chain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function project(files: Record<string, string>) {
    return inMemoryProject(files);
}

/** Convenience: extract refs only. */
function extractRefs(files: Record<string, string>) {
    return extractFilterChain(project(files)).refs;
}

/** Convenience: extract skippedAnonymousFiles only. */
function extractSkipped(files: Record<string, string>) {
    return extractFilterChain(project(files)).skippedAnonymousFiles;
}

// ---------------------------------------------------------------------------
// Class-level decorators
// ---------------------------------------------------------------------------

describe('extractFilterChain — class-level @UseGuards', () => {
    it('captures a bare identifier guard on a class', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                import { AuthGuard } from './auth.guard';
                @UseGuards(AuthGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
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
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                import { LoggingInterceptor } from './logging.interceptor';
                @Controller('cats')
                @UseInterceptors(LoggingInterceptor)
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect(refs[0].decorator).toBe('UseInterceptors');
        if (refs[0].kind === 'class' || refs[0].kind === 'instance') {
            expect(refs[0].name).toBe('LoggingInterceptor');
        }
        expect(refs[0].attachedTo).toEqual({ kind: 'class' });
    });

    it('captures a bare identifier pipe on a class', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UsePipes } from '@nestjs/common';
                import { ValidationPipe } from '@nestjs/common';
                @UsePipes(ValidationPipe)
                @Controller('cats')
                export class CatsController {}
            `,
        });
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
        const refs = extractRefs({
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
        const refs = extractRefs({
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
        expect(refs).toHaveLength(1);
        expect(refs[0].attachedTo).toEqual({ kind: 'method', methodName: 'findAll' });
        expect(refs[0].decorator).toBe('UseInterceptors');
    });

    it('captures a pipe on a method', () => {
        const refs = extractRefs({
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
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                import { AuthGuard } from './auth.guard';
                import { RoleGuard } from './role.guard';
                @UseGuards(AuthGuard, RoleGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
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
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(GuardA, GuardB, GuardC)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(3);
        expect(refs.map((r) => (r as { name: string }).name)).toEqual(['GuardA', 'GuardB', 'GuardC']);
    });
});

// ---------------------------------------------------------------------------
// Instance (new) arguments
// ---------------------------------------------------------------------------

describe('extractFilterChain — instance (new) arguments', () => {
    it('emits an instance ref for @UseInterceptors(new LoggingInterceptor())', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                import { LoggingInterceptor } from './logging.interceptor';
                @UseInterceptors(new LoggingInterceptor())
                @Controller('cats')
                export class CatsController {}
            `,
        });
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
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @UseGuards(new AuthGuard('jwt'))
                    findAll() {}
                }
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('instance');
        if (refs[0].kind === 'instance') {
            expect(refs[0].name).toBe('AuthGuard');
        }
    });

    it('emits unresolved for new with non-identifier expression (new factory.create())', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                declare const factory: any;
                @Controller('cats')
                export class CatsController {
                    @UseGuards(new factory.create())
                    findAll() {}
                }
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('unresolved');
        expect((refs[0] as { reason: string }).reason).toBe('new-non-identifier-expression');
    });
});

// ---------------------------------------------------------------------------
// All three decorators on same class
// ---------------------------------------------------------------------------

describe('extractFilterChain — all three decorators on the same class', () => {
    it('emits three separate refs for @UseGuards, @UseInterceptors, @UsePipes', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards, UseInterceptors, UsePipes } from '@nestjs/common';
                @UseGuards(AuthGuard)
                @UseInterceptors(LoggingInterceptor)
                @UsePipes(ValidationPipe)
                @Controller('cats')
                export class CatsController {}
            `,
        });
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
        const refs = extractRefs({
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
        expect(refs).toHaveLength(2);
        const classRef = refs.find((r) => r.attachedTo.kind === 'class');
        const methodRef = refs.find((r) => r.attachedTo.kind === 'method');
        expect((classRef as { name?: string })?.name).toBe('AuthGuard');
        expect((methodRef as { name?: string })?.name).toBe('RoleGuard');
        expect(methodRef?.attachedTo).toEqual({ kind: 'method', methodName: 'findAll' });
    });
});

// ---------------------------------------------------------------------------
// Namespace-qualified identifier: @UseGuards(Namespace.Guard)
// ---------------------------------------------------------------------------

describe('extractFilterChain — namespace-qualified identifier', () => {
    it('resolves rightmost identifier for @UseGuards(Auth.Guard)', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                import * as Auth from './auth';
                @UseGuards(Auth.Guard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect((refs[0] as { name: string }).name).toBe('Guard');
    });
});

// ---------------------------------------------------------------------------
// Parenthesized / as-expression unwrapping
// ---------------------------------------------------------------------------

describe('extractFilterChain — parenthesized and as-expression unwrapping', () => {
    it('unwraps parenthesized expression @UseGuards((AuthGuard))', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards((AuthGuard))
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect((refs[0] as { name: string }).name).toBe('AuthGuard');
    });

    it('unwraps as-expression @UseGuards(AuthGuard as any)', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard as any)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('class');
        expect((refs[0] as { name: string }).name).toBe('AuthGuard');
    });
});

// ---------------------------------------------------------------------------
// Unresolved arguments
// ---------------------------------------------------------------------------

describe('extractFilterChain — unresolved arguments', () => {
    it('emits unresolved for @UseGuards(...spread)', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                const guards = [AuthGuard, RoleGuard];
                @UseGuards(...guards)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        // Each spread element in the arg list is emitted
        const unresolved = refs.filter((r) => r.kind === 'unresolved');
        expect(unresolved.length).toBeGreaterThan(0);
        expect(unresolved[0].decorator).toBe('UseGuards');
        // Verify the reason contains SpreadElement
        expect((unresolved[0] as { reason: string }).reason).toContain('SpreadElement');
    });

    it('emits unresolved for a ternary in @UseGuards', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                const prod = true;
                @UseGuards(prod ? AuthGuard : MockGuard)
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('unresolved');
        expect(refs[0].decorator).toBe('UseGuards');
        expect((refs[0] as { reason: string }).reason).toContain('unresolved-arg-kind');
    });

    it('emits unresolved for a function call in @UseInterceptors', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseInterceptors } from '@nestjs/common';
                function makeInterceptor() { return null as any; }
                @UseInterceptors(makeInterceptor())
                @Controller('cats')
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(1);
        expect(refs[0].kind).toBe('unresolved');
    });
});

// ---------------------------------------------------------------------------
// Excluded files
// ---------------------------------------------------------------------------

describe('extractFilterChain — excluded files', () => {
    it('skips files under /node_modules/', () => {
        const refs = extractRefs({
            '/node_modules/some-lib/src/controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                export class LibController {}
            `,
        });
        expect(refs).toHaveLength(0);
    });

    it('skips files under /dist/', () => {
        const refs = extractRefs({
            '/dist/cats.controller.js': `
                @UseGuards(AuthGuard)
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(0);
    });

    it('skips .test.ts files', () => {
        const refs = extractRefs({
            '/src/cats.controller.test.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards(TestGuard)
                export class CatsController {}
            `,
        });
        expect(refs).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Empty / unrelated files
// ---------------------------------------------------------------------------

describe('extractFilterChain — empty or unrelated decorators', () => {
    it('returns empty for a file with no classes', () => {
        const refs = extractRefs({ '/src/constants.ts': `export const FOO = 'foo';` });
        expect(refs).toHaveLength(0);
    });

    it('returns empty for a class with no filter decorators', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, Get } from '@nestjs/common';
                @Controller('cats')
                export class CatsController {
                    @Get()
                    findAll() { return []; }
                }
            `,
        });
        expect(refs).toHaveLength(0);
    });

    it('returns empty for an empty file', () => {
        const refs = extractRefs({ '/src/empty.ts': '' });
        expect(refs).toHaveLength(0);
    });

    it('reports anonymous class files in skippedAnonymousFiles instead of silently dropping', () => {
        const p = project({
            '/src/anon.ts': `
                import { UseGuards } from '@nestjs/common';
                export default class {
                    @UseGuards(AuthGuard)
                    findAll() {}
                }
            `,
        });
        const { refs, skippedAnonymousFiles } = extractFilterChain(p);
        // No refs emitted for anonymous classes — but the file IS recorded
        expect(refs).toHaveLength(0);
        expect(skippedAnonymousFiles.some((f) => f.includes('anon.ts'))).toBe(true);
    });

    it('does not emit refs for decorator with no arguments', () => {
        const refs = extractRefs({
            '/src/cats.controller.ts': `
                import { Controller, UseGuards } from '@nestjs/common';
                @UseGuards()
                @Controller('cats')
                export class CatsController {}
            `,
        });
        // @UseGuards() with zero args → nothing to emit
        expect(refs).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe('extractFilterChain — multiple files', () => {
    it('collects refs from multiple source files', () => {
        const refs = extractRefs({
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
        expect(refs).toHaveLength(2);
        const decorators = new Set(refs.map((r) => r.decorator));
        expect(decorators.has('UseGuards')).toBe(true);
        expect(decorators.has('UseInterceptors')).toBe(true);
    });

    it('skips excluded file while processing valid file', () => {
        const refs = extractRefs({
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
        expect(refs).toHaveLength(1);
        expect((refs[0] as { name: string }).name).toBe('AuthGuard');
    });
});

// ---------------------------------------------------------------------------
// Inheritance (documentation test — non-inheritance behaviour)
// ---------------------------------------------------------------------------

describe('extractFilterChain — inheritance (non-inheritance documented)', () => {
    it('does not inherit decorators from parent class — only direct decorators are captured', () => {
        // The extractor only walks the class's own decorators / method decorators.
        // Parent-class decorators are NOT inherited — that is NestJS runtime behaviour,
        // not something the static extractor models.
        const refs = extractRefs({
            '/src/base.controller.ts': `
                import { UseGuards } from '@nestjs/common';
                @UseGuards(AuthGuard)
                export class BaseController {}
            `,
            '/src/child.controller.ts': `
                export class ChildController extends BaseController {}
            `,
        });
        // Only BaseController has the decorator — ChildController emits nothing
        expect(refs).toHaveLength(1);
        expect(refs[0].enclosingClass).toBe('BaseController');
    });
});
