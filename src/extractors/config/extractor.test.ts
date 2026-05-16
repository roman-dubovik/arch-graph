import { describe, expect, it } from 'vitest';
import { extractConfig } from './extractor.js';
import { inMemoryProject } from '../../__fixtures__/in-memory-project.js';

describe('extractConfig', () => {
    it('returns empty for project with no configService or process.env', () => {
        const project = inMemoryProject({
            '/app/service.ts': `export class MyService { hello() { return 1; } }`,
        });
        const result = extractConfig(project);
        expect(result.fields).toHaveLength(0);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('detects configService.get("KEY") inside a method', () => {
        const project = inMemoryProject({
            '/app/auth.service.ts': `
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class AuthService {
    constructor(private readonly configService: ConfigService) {}
    getJwtSecret() {
        return this.configService.get('JWT_SECRET');
    }
}
`,
        });
        const result = extractConfig(project);
        const field = result.fields.find((f) => f.key === 'JWT_SECRET');
        expect(field).toBeDefined();
        expect(field!.source).toBe('configService');
        expect(field!.consumerClass).toBe('AuthService');
    });

    it('detects configService.getOrThrow("KEY")', () => {
        const project = inMemoryProject({
            '/app/db.service.ts': `
import { ConfigService } from '@nestjs/config';
export class DbService {
    constructor(private configService: ConfigService) {}
    getUrl() {
        return this.configService.getOrThrow('DATABASE_URL');
    }
}
`,
        });
        const result = extractConfig(project);
        const field = result.fields.find((f) => f.key === 'DATABASE_URL');
        expect(field).toBeDefined();
        expect(field!.source).toBe('configService');
    });

    it('detects process.env.KEY member access', () => {
        const project = inMemoryProject({
            '/app/env.ts': `
export function getPort() {
    return process.env.PORT;
}
`,
        });
        const result = extractConfig(project);
        const field = result.fields.find((f) => f.key === 'PORT');
        expect(field).toBeDefined();
        expect(field!.source).toBe('process.env');
    });

    it('detects multiple process.env keys in one file', () => {
        const project = inMemoryProject({
            '/app/env.ts': `
export const config = {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    apiKey: process.env.API_KEY,
};
`,
        });
        const result = extractConfig(project);
        const keys = result.fields.map((f) => f.key);
        expect(keys).toContain('NODE_ENV');
        expect(keys).toContain('PORT');
        expect(keys).toContain('API_KEY');
    });

    it('detects both configService and process.env in same file', () => {
        const project = inMemoryProject({
            '/app/mixed.service.ts': `
import { ConfigService } from '@nestjs/config';
export class MixedService {
    constructor(private readonly configService: ConfigService) {}
    getData() {
        const key = this.configService.get('MY_KEY');
        const fallback = process.env.FALLBACK;
        return { key, fallback };
    }
}
`,
        });
        const result = extractConfig(project);
        const keys = result.fields.map((f) => f.key);
        expect(keys).toContain('MY_KEY');
        expect(keys).toContain('FALLBACK');
    });

    it('ignores configService.get with non-string first arg and emits diagnostic (P0-1)', () => {
        const project = inMemoryProject({
            '/app/dynamic.service.ts': `
import { ConfigService } from '@nestjs/config';
export class DynService {
    constructor(private configService: ConfigService) {}
    get(key: string) {
        return this.configService.get(key);
    }
}
`,
        });
        const result = extractConfig(project);
        // Dynamic key — should be ignored (no string literal) but diagnostic emitted
        expect(result.fields).toHaveLength(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('non-literal key');
    });

    it('emits diagnostic for template-literal-with-substitution key', () => {
        const project = inMemoryProject({
            '/app/template.service.ts': `
import { ConfigService } from '@nestjs/config';
export class TplService {
    constructor(private configService: ConfigService) {}
    get(suffix: string) {
        return this.configService.get(\`KEY_\${suffix}\`);
    }
}
`,
        });
        const result = extractConfig(project);
        // Template literal with substitution → non-literal → diagnostic
        expect(result.fields).toHaveLength(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('extracts key from NoSubstitutionTemplateLiteral (backtick with no substitution)', () => {
        // configService.get(`DB_PASSWORD`) uses a NoSubstitutionTemplateLiteral —
        // the extractor must handle it identically to a plain string literal.
        const project = inMemoryProject({
            '/app/db.service.ts': `
import { ConfigService } from '@nestjs/config';
export class DbService {
    constructor(private readonly configService: ConfigService) {}
    getPassword() {
        return this.configService.get(\`DB_PASSWORD\`);
    }
}
`,
        });
        const result = extractConfig(project);
        const field = result.fields.find((f) => f.key === 'DB_PASSWORD');
        expect(field).toBeDefined();
        expect(field!.source).toBe('configService');
        expect(field!.consumerClass).toBe('DbService');
        // No diagnostic should be emitted for a pure backtick literal
        expect(result.diagnostics).toHaveLength(0);
    });

    it('skips test files', () => {
        const project = inMemoryProject({
            '/app/config.spec.ts': `
import { ConfigService } from '@nestjs/config';
const cs = new ConfigService();
cs.get('SHOULD_NOT_APPEAR');
`,
        });
        const result = extractConfig(project);
        expect(result.fields).toHaveLength(0);
    });

    it('captures consumerClass inside nested class method', () => {
        const project = inMemoryProject({
            '/app/storage.service.ts': `
import { ConfigService } from '@nestjs/config';
export class StorageService {
    constructor(private configService: ConfigService) {
        const b = this.configService.get('S3_BUCKET');
    }
    getRegion() {
        return this.configService.getOrThrow('AWS_REGION');
    }
}
`,
        });
        const result = extractConfig(project);
        for (const f of result.fields) {
            expect(f.consumerClass).toBe('StorageService');
        }
        expect(result.fields.length).toBe(2);
    });

    it('returns undefined consumerClass for top-level callsite', () => {
        const project = inMemoryProject({
            '/app/top.ts': `
const env = process.env.TOP_LEVEL_KEY;
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'TOP_LEVEL_KEY');
        expect(f).toBeDefined();
        expect(f!.consumerClass).toBeUndefined();
    });

    it('includes location info', () => {
        const project = inMemoryProject({
            '/app/loc.service.ts': `
import { ConfigService } from '@nestjs/config';
export class LocService {
    constructor(private configService: ConfigService) {}
    run() { return this.configService.get('SOME_KEY'); }
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'SOME_KEY');
        expect(f).toBeDefined();
        expect(f!.location.file).toContain('loc.service.ts');
        expect(f!.location.line).toBeGreaterThan(0);
    });

    it('handles configService typed with generic argument', () => {
        const project = inMemoryProject({
            '/app/generic.service.ts': `
import { ConfigService } from '@nestjs/config';
export class GenericService {
    constructor(private configService: ConfigService) {}
    getTimeout() {
        return this.configService.get<number>('TIMEOUT_MS') ?? 3000;
    }
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'TIMEOUT_MS');
        expect(f).toBeDefined();
    });

    it('captures context from arrow function (ArrowFunction branch)', () => {
        const project = inMemoryProject({
            '/app/arrow.service.ts': `
import { ConfigService } from '@nestjs/config';
export class ArrowService {
    constructor(private configService: ConfigService) {}
    setup = () => {
        return this.configService.get('ARROW_KEY');
    };
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'ARROW_KEY');
        expect(f).toBeDefined();
        expect(f!.consumerClass).toBe('ArrowService');
    });

    it('captures context from getter (GetAccessor branch)', () => {
        const project = inMemoryProject({
            '/app/getter.service.ts': `
import { ConfigService } from '@nestjs/config';
export class GetterService {
    constructor(private configService: ConfigService) {}
    get dbUrl() {
        return this.configService.get('DB_URL_GETTER');
    }
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'DB_URL_GETTER');
        expect(f).toBeDefined();
        expect(f!.consumerClass).toBe('GetterService');
        expect(f!.consumerContext).toBe('dbUrl');
    });

    it('handles process.env in function expression', () => {
        const project = inMemoryProject({
            '/app/fn-expr.ts': `
const fn = function() {
    return process.env.FN_EXPR_KEY;
};
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'FN_EXPR_KEY');
        expect(f).toBeDefined();
    });

    it('ignores file with neither configService nor process.env', () => {
        const project = inMemoryProject({
            '/app/noenv.ts': `
export function compute(x: number) { return x * 2; }
`,
        });
        const result = extractConfig(project);
        expect(result.fields).toHaveLength(0);
    });

    it('ignores .get() calls on non-config objects', () => {
        // map.get('key') or repo.get('thing') should be ignored
        const project = inMemoryProject({
            '/app/map.service.ts': `
export class MapService {
    private cache = new Map<string, string>();
    run() {
        // these should NOT be detected as config callsites
        const x = this.cache.get('some-key');
        const y = this.userRepo.get('user-id');
        return { x, y };
    }
}
`,
        });
        const result = extractConfig(project);
        expect(result.fields).toHaveLength(0);
    });

    it('handles configService.get with no args (empty args branch)', () => {
        const project = inMemoryProject({
            '/app/noarg.service.ts': `
import { ConfigService } from '@nestjs/config';
export class NoArgService {
    constructor(private readonly configService: ConfigService) {}
    run() {
        // no-arg get — should be ignored
        return this.configService.get();
    }
}
`,
        });
        const result = extractConfig(project);
        // No string literal arg, so nothing detected
        expect(result.fields).toHaveLength(0);
    });

    it('captures context from setter (SetAccessor branch)', () => {
        const project = inMemoryProject({
            '/app/setter.service.ts': `
import { ConfigService } from '@nestjs/config';
export class SetterService {
    private configService = {} as ConfigService;
    set dbUrl(val: string) {
        const x = this.configService.get('DB_URL_SETTER');
    }
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'DB_URL_SETTER');
        expect(f).toBeDefined();
        expect(f!.consumerClass).toBe('SetterService');
        expect(f!.consumerContext).toBe('dbUrl');
    });

    it('captures context from top-level named function declaration (FunctionDeclaration branch)', () => {
        const project = inMemoryProject({
            '/app/loader.ts': `
import { ConfigService } from '@nestjs/config';
const configService = {} as ConfigService;
export function loadConfig() {
    return configService.get('LOAD_KEY');
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'LOAD_KEY');
        expect(f).toBeDefined();
        expect(f!.consumerContext).toBe('loadConfig');
        expect(f!.consumerClass).toBeUndefined();
    });

    it('captures context from class method (MethodDeclaration branch confirms name)', () => {
        const project = inMemoryProject({
            '/app/method.service.ts': `
import { ConfigService } from '@nestjs/config';
export class MethodService {
    constructor(private configService: ConfigService) {}
    fetchTimeout() {
        return this.configService.get('METHOD_TIMEOUT');
    }
}
`,
        });
        const result = extractConfig(project);
        const f = result.fields.find((x) => x.key === 'METHOD_TIMEOUT');
        expect(f).toBeDefined();
        expect(f!.consumerContext).toBe('fetchTimeout');
        expect(f!.consumerClass).toBe('MethodService');
    });
});
