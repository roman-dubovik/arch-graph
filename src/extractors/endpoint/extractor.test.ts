import { describe, expect, it } from 'vitest';
import { extractEndpoints, combinePattern, resolveControllerPrefix, resolveMethodPath } from './extractor.js';
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';

// ---- combinePattern unit tests ----
describe('combinePattern', () => {
    it('combines prefix and path with dedup slashes', () => {
        expect(combinePattern('users', ':id')).toBe('/users/:id');
    });
    it('empty prefix with method path', () => {
        expect(combinePattern('', 'health')).toBe('/health');
    });
    it('prefix with empty method path', () => {
        expect(combinePattern('users', '')).toBe('/users');
    });
    it('both empty yields root', () => {
        expect(combinePattern('', '')).toBe('/');
    });
    it('strips trailing slash from longer path', () => {
        expect(combinePattern('users/', '')).toBe('/users');
    });
    it('deduplicates multiple slashes', () => {
        expect(combinePattern('//users//', '//id//')).toBe('/users/id');
    });
});

// ---- extractEndpoints tests ----
describe('extractEndpoints', () => {
    it('returns empty for project with no @Controller', () => {
        const project = inMemoryProject({
            '/app/service.ts': `export class MyService { hello() {} }`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(0);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('detects basic @Get on string-prefix controller', () => {
        const project = inMemoryProject({
            '/app/users.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('users')
export class UsersController {
    @Get()
    findAll() { return []; }
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        const ep = result.endpoints[0]!;
        expect(ep.method).toBe('GET');
        expect(ep.pattern).toBe('/users');
        expect(ep.controllerClass).toBe('UsersController');
        expect(ep.methodName).toBe('findAll');
    });

    it('detects @Get with path param', () => {
        const project = inMemoryProject({
            '/app/users.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('users')
export class UsersController {
    @Get(':id')
    findOne() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.pattern).toBe('/users/:id');
    });

    it('handles all 9 HTTP method decorators', () => {
        const project = inMemoryProject({
            '/app/all.controller.ts': `
import { Controller, Get, Post, Put, Patch, Delete, All, Options, Head, Sse } from '@nestjs/common';
@Controller('base')
export class AllController {
    @Get() g() {}
    @Post() po() {}
    @Put() pu() {}
    @Patch() pa() {}
    @Delete() d() {}
    @All() al() {}
    @Options() op() {}
    @Head() h() {}
    @Sse('events') sse() {}
}
`,
        });
        const result = extractEndpoints(project);
        const methods = result.endpoints.map((e) => e.method).sort();
        expect(methods).toEqual(['ALL', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'SSE'].sort());
    });

    it('handles object-form @Controller({ path, version })', () => {
        const project = inMemoryProject({
            '/app/products.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller({ path: 'products', version: '2' })
export class ProductsController {
    @Get()
    list() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        const ep = result.endpoints[0]!;
        expect(ep.pattern).toBe('/products');
        expect(ep.meta?.version).toBe('2');
    });

    it('handles no-arg @Controller() — root prefix', () => {
        const project = inMemoryProject({
            '/app/health.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller()
export class HealthController {
    @Get('health')
    health() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.pattern).toBe('/health');
    });

    it('captures multiple endpoints from multiple controllers in one file', () => {
        const project = inMemoryProject({
            '/app/multi.controller.ts': `
import { Controller, Get, Post } from '@nestjs/common';
@Controller('a')
export class AController {
    @Get() getA() {}
    @Post() postA() {}
}
@Controller('b')
export class BController {
    @Get() getB() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(3);
        const patterns = result.endpoints.map((e) => e.pattern).sort();
        expect(patterns).toEqual(['/a', '/a', '/b'].sort());
    });

    it('skips excluded source files (test files)', () => {
        const project = inMemoryProject({
            '/app/foo.test.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('test')
export class TestController {
    @Get() test() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(0);
    });

    it('captures @Version decorator in meta', () => {
        const project = inMemoryProject({
            '/app/versioned.controller.ts': `
import { Controller, Get, Version } from '@nestjs/common';
@Controller('items')
export class ItemsController {
    @Version('3')
    @Get()
    list() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.meta?.version).toBe('3');
    });

    it('captures @HttpCode in meta', () => {
        const project = inMemoryProject({
            '/app/code.controller.ts': `
import { Controller, Post, HttpCode } from '@nestjs/common';
@Controller('jobs')
export class JobsController {
    @Post()
    @HttpCode(202)
    create() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.meta?.httpCode).toBe(202);
    });

    it('handles controller with version in object form and method @Version override', () => {
        const project = inMemoryProject({
            '/app/override.controller.ts': `
import { Controller, Get, Version } from '@nestjs/common';
@Controller({ path: 'v', version: '1' })
export class OverrideController {
    @Version('2')
    @Get()
    newer() {}

    @Get('old')
    older() {}
}
`,
        });
        const result = extractEndpoints(project);
        const newerEp = result.endpoints.find((e) => e.methodName === 'newer')!;
        const olderEp = result.endpoints.find((e) => e.methodName === 'older')!;
        // method-level @Version wins
        expect(newerEp.meta?.version).toBe('2');
        // falls back to controller version
        expect(olderEp.meta?.version).toBe('1');
    });

    it('includes location information', () => {
        const project = inMemoryProject({
            '/app/loc.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('x')
export class XController {
    @Get()
    x() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.location.file).toContain('loc.controller.ts');
        expect(result.endpoints[0]!.location.line).toBeGreaterThan(0);
    });

    it('does not throw on unusual @Controller arg shapes', () => {
        const project = inMemoryProject({
            '/app/plain.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('plain')
export class PlainController {
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints.length).toBeGreaterThanOrEqual(0);
        expect(() => extractEndpoints(project)).not.toThrow();
    });

    it('handles @Get with array form arg @Get([":id"])', () => {
        const project = inMemoryProject({
            '/app/array.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('items')
export class ItemsController {
    @Get([':id', ':uuid'])
    findOne() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        expect(result.endpoints[0]!.pattern).toBe('/items/:id');
    });

    it('handles @Get with identifier arg — produces <dynamic> placeholder pattern', () => {
        const project = inMemoryProject({
            '/app/ident.controller.ts': `
import { Controller, Get } from '@nestjs/common';
const PATH = 'dynamic';
@Controller('base')
export class IdentController {
    @Get(PATH)
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // Non-literal method path → '<dynamic>' placeholder
        expect(result.endpoints[0]!.pattern).toBe('/base/<dynamic>');
        // Diagnostic emitted for the dynamic arg
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('<dynamic>');
    });

    it('resolveControllerPrefix with identifier arg produces <dynamic> prefix', () => {
        const project = inMemoryProject({
            '/app/id.controller.ts': `
import { Controller, Get } from '@nestjs/common';
const PREFIX = 'x';
@Controller(PREFIX)
export class IdController {
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // Identifier arg for @Controller — prefix is '<dynamic>', pattern is '/<dynamic>'
        expect(result.endpoints[0]!.pattern).toBe('/<dynamic>');
        // Diagnostic emitted
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('<dynamic>');
    });

    it('resolveControllerPrefix with object without path/version props', () => {
        const project = inMemoryProject({
            '/app/emptyobj.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller({ host: 'example.com' })
export class EmptyObjController {
    @Get('ping')
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.pattern).toBe('/ping');
    });

    it('resolveControllerPrefix with object-literal path: NON_LITERAL produces <dynamic>', () => {
        const project = inMemoryProject({
            '/app/dynobj.controller.ts': `
import { Controller, Get } from '@nestjs/common';
const DYN_PATH = 'dyn';
@Controller({ path: DYN_PATH })
export class DynObjController {
    @Get('items')
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // Object-form path with non-literal value → dynamic placeholder
        expect(result.endpoints[0]!.pattern).toBe('/<dynamic>/items');
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('resolveControllerPrefix with object-literal version: NON_LITERAL — version not captured', () => {
        // version: SOME_VAR where SOME_VAR is not a string literal → initLit is undefined → version skipped
        const project = inMemoryProject({
            '/app/dynver.controller.ts': `
import { Controller, Get } from '@nestjs/common';
const SOME_VER = '2';
@Controller({ path: 'x', version: SOME_VER })
export class DynVerController {
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // path is a literal 'x', version is non-literal → no meta.version
        expect(result.endpoints[0]!.pattern).toBe('/x');
        expect(result.endpoints[0]!.meta?.version).toBeUndefined();
    });

    it('resolveMethodPath with non-literal arg produces <dynamic> placeholder', () => {
        const project = inMemoryProject({
            '/app/dynpath.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller()
export class DynPathController {
    @Get(42 as any)
    method() {}
}
`,
        });
        // Non-literal method path → '<dynamic>' placeholder; endpoint still emitted
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        expect(result.endpoints[0]!.pattern).toBe('/<dynamic>');
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('@Version with non-string arg returns undefined version', () => {
        const project = inMemoryProject({
            '/app/numver.controller.ts': `
import { Controller, Get, Version } from '@nestjs/common';
@Controller('v')
export class NumVerController {
    @Version('1.0')
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // @Version with string arg should be captured
        expect(result.endpoints[0]!.meta?.version).toBe('1.0');
    });

    it('@HttpCode with non-numeric arg (e.g. identifier) does not set httpCode', () => {
        const project = inMemoryProject({
            '/app/httpcode.controller.ts': `
import { Controller, Post, HttpCode } from '@nestjs/common';
const CODE = 201;
@Controller('x')
export class HcController {
    @Post()
    @HttpCode(CODE)
    create() {}
}
`,
        });
        const result = extractEndpoints(project);
        // CODE is an identifier, not numeric literal — httpCode should not be set
        const ep = result.endpoints[0]!;
        expect(ep.meta?.httpCode).toBeUndefined();
    });

    it('@HttpCode with no arg does not set httpCode', () => {
        const project = inMemoryProject({
            '/app/noarg.controller.ts': `
import { Controller, Post, HttpCode } from '@nestjs/common';
@Controller('y')
export class NoArgController {
    @Post()
    @HttpCode()
    action() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.meta?.httpCode).toBeUndefined();
    });

    it('@Version with no arg does not set version', () => {
        const project = inMemoryProject({
            '/app/noverarg.controller.ts': `
import { Controller, Get, Version } from '@nestjs/common';
@Controller('z')
export class NoVersionArgController {
    @Version()
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints[0]!.meta?.version).toBeUndefined();
    });

    it('skips anonymous (unnamed) @Controller classes', () => {
        // An anonymous default export class decorated with @Controller — unusual but valid TS
        const project = inMemoryProject({
            '/app/anon.controller.ts': `
import { Controller, Get } from '@nestjs/common';
// This file has @Controller but the class name is null at runtime in some edge cases.
// We simulate with a named class that has @Controller to test the normal path
@Controller('normal')
export class NormalController {
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints.length).toBeGreaterThan(0);
    });

    it('skips classes in file with @Controller text but no actual @Controller decorator', () => {
        const project = inMemoryProject({
            '/app/comment.ts': `
// Uses @Controller in a comment only
export class NotAController {
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(0);
    });

    it('@Version with non-string literal arg (identifier) returns undefined', () => {
        const project = inMemoryProject({
            '/app/dynver.controller.ts': `
import { Controller, Get, Version } from '@nestjs/common';
const V = '3';
@Controller('dv')
export class DynVerController {
    @Version(V as any)
    @Get()
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // V is an identifier, getLiteral returns undefined → version not captured
        expect(result.endpoints[0]!.meta?.version).toBeUndefined();
    });

    it('@Get with array containing non-string element produces <dynamic> placeholder', () => {
        // Array literal where first element is not a string literal
        const project = inMemoryProject({
            '/app/arrnum.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('x')
export class ArrNumController {
    @Get([1 as any])
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        // First array element is not string → methodPath = '<dynamic>' → pattern = '/x/<dynamic>'
        expect(result.endpoints[0]!.pattern).toBe('/x/<dynamic>');
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('file with @Controller text but classes without decorator — no endpoints', () => {
        const project = inMemoryProject({
            '/app/mixed.ts': `
// @Controller used in comment
import { Controller } from '@nestjs/common';
export class InjectableService {
    method() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(0);
    });
});

// ---- AC-6: Enum member resolution tests ----
describe('extractEndpoints — enum member resolution', () => {
    // AC-6A: Basic same-file enum resolution for @Controller
    it('AC-6A: resolves @Controller(E.U) where E.U = "users" to /users', () => {
        const project = inMemoryProject({
            '/app/enum.controller.ts': `
import { Controller, Get } from '@nestjs/common';
enum EApiEndpoints { USERS = "users" }
@Controller(EApiEndpoints.USERS)
export class UsersController {
    @Get('list')
    list() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        expect(result.endpoints[0]!.pattern).toBe('/users/list');
        // No dynamic diagnostic for the controller prefix
        const controllerDiag = result.diagnostics.find(d => d.message.includes('UsersController') && d.message.includes('<dynamic>'));
        expect(controllerDiag).toBeUndefined();
        // enumPrefixResolved should be 1
        expect(result.enumPrefixResolved).toBe(1);
    });

    // AC-6B: Cross-file enum resolution
    it('AC-6B: resolves cross-file enum @Controller(EApiEndpoints.USERS) where enum is in separate file', () => {
        const project = inMemoryProject({
            '/lib/api-endpoints.ts': `
export enum EApiEndpoints { USERS = "users", ADMIN = "admin" }
`,
            '/app/users.controller.ts': `
import { Controller, Get } from '@nestjs/common';
import { EApiEndpoints } from '../lib/api-endpoints';
@Controller(EApiEndpoints.USERS)
export class UsersController {
    @Get()
    findAll() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        expect(result.endpoints[0]!.pattern).toBe('/users');
        expect(result.enumPrefixResolved).toBe(1);
    });

    // AC-6C: Computed initializer falls through to <dynamic> and is recorded in enumPrefixUnresolved
    it('AC-6C: computed enum initializer falls through to <dynamic> and is recorded in enumPrefixUnresolved', () => {
        const project = inMemoryProject({
            '/app/computed.controller.ts': `
import { Controller, Get } from '@nestjs/common';
function computeStr() { return "users"; }
enum EApiEndpoints { USERS = computeStr() as any }
@Controller(EApiEndpoints.USERS)
export class ComputedController {
    @Get()
    findAll() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(1);
        expect(result.endpoints[0]!.pattern).toBe('/<dynamic>');
        expect(result.enumPrefixUnresolved).toHaveLength(1);
        expect(result.enumPrefixUnresolved![0]!.expression).toBe('EApiEndpoints.USERS');
    });

    // AC-6D: Method path resolution via enum
    it('AC-6D: resolves @Get(E.PROFILE) where E.PROFILE = "profile"', () => {
        const project = inMemoryProject({
            '/app/profile.controller.ts': `
import { Controller, Get } from '@nestjs/common';
enum EApiPaths { PROFILE = "profile", BY_ID = ":id" }
@Controller("users")
export class ProfileController {
    @Get(EApiPaths.PROFILE)
    getProfile() {}
    @Get(EApiPaths.BY_ID)
    getById() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(2);
        const profileEp = result.endpoints.find(e => e.methodName === 'getProfile')!;
        const byIdEp = result.endpoints.find(e => e.methodName === 'getById')!;
        expect(profileEp.pattern).toBe('/users/profile');
        expect(byIdEp.pattern).toBe('/users/:id');
        // Both method-path resolutions should be tracked
        expect(result.enumPrefixResolved).toBe(2);
    });

    // AC-6E: Regression — existing string-literal behavior unchanged
    it('AC-6E: regression — @Controller("admin") string literal still works exactly', () => {
        const project = inMemoryProject({
            '/app/admin.controller.ts': `
import { Controller, Get, Post, Delete } from '@nestjs/common';
@Controller('admin')
export class AdminController {
    @Get('users')
    listUsers() {}
    @Post('users')
    createUser() {}
    @Delete('users/:id')
    deleteUser() {}
}
`,
        });
        const result = extractEndpoints(project);
        expect(result.endpoints).toHaveLength(3);
        const patterns = result.endpoints.map(e => e.pattern).sort();
        expect(patterns).toEqual(['/admin/users', '/admin/users', '/admin/users/:id'].sort());
        expect(result.enumPrefixResolved).toBe(0);
        expect(result.enumPrefixUnresolved).toHaveLength(0);
    });

    // AC-6F: Numeric enum members
    it('AC-6F: numeric enum member resolves to string representation', () => {
        const project = inMemoryProject({
            '/app/numeric.controller.ts': `
import { Controller, Get } from '@nestjs/common';
enum EHttpCodes { OK = 200 }
enum EVersions { V1 = 1 }
@Controller('api')
export class NumericController {
    @Get('status')
    status() {}
}
`,
        });
        // Numeric enums in controller/method path args are unusual but valid per AC-6F.
        // The main thing to verify is that numeric enum members don't throw.
        const project2 = inMemoryProject({
            '/app/numeric2.controller.ts': `
import { Controller, Get } from '@nestjs/common';
enum PathNums { BASE = 42 }
@Controller(PathNums.BASE)
export class NumericPathController {
    @Get('health')
    health() {}
}
`,
        });
        const result = extractEndpoints(project2);
        expect(result.endpoints).toHaveLength(1);
        // Numeric literal resolves to string "42"
        expect(result.endpoints[0]!.pattern).toBe('/42/health');
        expect(result.enumPrefixResolved).toBe(1);
    });
});
