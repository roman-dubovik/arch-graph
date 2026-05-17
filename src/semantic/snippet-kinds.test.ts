/**
 * Tests for kind-aware snippet extraction (A8).
 *
 * Covers the new switch-based extractors: provider, module, endpoint,
 * db-entity-field, config-field, fe-component, fe-hook, fe-route.
 */
import { describe, expect, it } from 'vitest';
import { Project, ts } from 'ts-morph';

import type { GraphNode } from '../core/types.js';
import { buildAnchor } from '../mapper/anchor.js';
import { FE_SNIPPET_MAX_CHARS, SNIPPET_MAX_CHARS, extractSnippet } from './snippet.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'label'>): GraphNode {
    return { ...overrides };
}

// ---------------------------------------------------------------------------
// provider — kind-aware (A1 + A8)
// ---------------------------------------------------------------------------

describe('extractSnippet — provider kind', () => {
    it('extracts class text via anchor (class name)', () => {
        const project = inMemoryProject({
            '/apps/auth/src/auth.service.ts': `
@Injectable()
export class AuthService {
  login() { return true; }
}
`,
        });
        const node = makeNode({
            id: 'provider:AuthService',
            kind: 'provider',
            label: 'AuthService',
            path: '/apps/auth/src/auth.service.ts',
            anchor: buildAnchor('AuthService', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('AuthService');
        expect(result.reason).toBeUndefined();
    });

    it('falls back to label when anchor is missing', () => {
        const project = inMemoryProject({
            '/apps/auth/src/auth.service.ts': `export class AuthService {}`,
        });
        const node = makeNode({
            id: 'provider:AuthService',
            kind: 'provider',
            label: 'AuthService',
            path: '/apps/auth/src/auth.service.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('AuthService');
    });

    it('returns label-not-located when class is absent', () => {
        const project = inMemoryProject({
            '/apps/auth/src/auth.service.ts': `export class OtherService {}`,
        });
        const node = makeNode({
            id: 'provider:AuthService',
            kind: 'provider',
            label: 'AuthService',
            path: '/apps/auth/src/auth.service.ts',
            anchor: buildAnchor('AuthService', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });
});

// ---------------------------------------------------------------------------
// endpoint — kind-aware (A2 + A8)
// ---------------------------------------------------------------------------

describe('extractSnippet — endpoint kind', () => {
    it('extracts method text via Class.method anchor', () => {
        const project = inMemoryProject({
            '/apps/api/src/users.controller.ts': `
import { Controller, Get, Post } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(id: string) { return { id }; }
  @Post()
  create() { return {}; }
}
`,
        });
        const node = makeNode({
            id: 'endpoint:GET /users/:id',
            kind: 'endpoint',
            label: 'GET /users/:id',
            path: '/apps/api/src/users.controller.ts',
            anchor: buildAnchor('UsersController.findOne', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('findOne');
        expect(result.snippet).not.toContain('create'); // only the method
        expect(result.reason).toBeUndefined();
    });

    it('returns label-not-located when anchor class not found', () => {
        const project = inMemoryProject({
            '/apps/api/src/users.controller.ts': `export class OtherController {}`,
        });
        const node = makeNode({
            id: 'endpoint:GET /users',
            kind: 'endpoint',
            label: 'GET /users',
            path: '/apps/api/src/users.controller.ts',
            anchor: buildAnchor('UsersController.findAll', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });

    it('returns label-not-located when method not found on existing class', () => {
        const project = inMemoryProject({
            '/apps/api/src/users.controller.ts': `export class UsersController { other() {} }`,
        });
        const node = makeNode({
            id: 'endpoint:GET /users',
            kind: 'endpoint',
            label: 'GET /users',
            path: '/apps/api/src/users.controller.ts',
            anchor: buildAnchor('UsersController.findAll', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });

    it('caps snippet at SNIPPET_MAX_CHARS', () => {
        const longBody = 'const x = ' + '0;'.repeat(300);
        const project = inMemoryProject({
            '/apps/api/src/big.controller.ts': `
export class BigController {
  create() {
    ${longBody}
    return {};
  }
}
`,
        });
        const node = makeNode({
            id: 'endpoint:POST /big',
            kind: 'endpoint',
            label: 'POST /big',
            path: '/apps/api/src/big.controller.ts',
            anchor: buildAnchor('BigController.create', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    });
});

// ---------------------------------------------------------------------------
// db-entity-field — kind-aware (A4 + A8)
// ---------------------------------------------------------------------------

describe('extractSnippet — db-entity-field kind', () => {
    it('extracts property declaration with decorator via Class.prop anchor', () => {
        const project = inMemoryProject({
            '/apps/db/src/user.entity.ts': `
import { Column, Entity } from 'typeorm';
@Entity('users')
export class User {
  @Column({ type: 'varchar' })
  email: string;

  @Column({ nullable: true })
  name: string;
}
`,
        });
        const node = makeNode({
            id: 'db-entity-field:users/email',
            kind: 'db-entity-field',
            label: 'users/email',
            path: '/apps/db/src/user.entity.ts',
            anchor: buildAnchor('User.email', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('email');
        expect(result.snippet).toContain('@Column');
        expect(result.reason).toBeUndefined();
    });

    it('returns label-not-located when property not found', () => {
        const project = inMemoryProject({
            '/apps/db/src/user.entity.ts': `export class User { name: string; }`,
        });
        const node = makeNode({
            id: 'db-entity-field:users/email',
            kind: 'db-entity-field',
            label: 'users/email',
            path: '/apps/db/src/user.entity.ts',
            anchor: buildAnchor('User.email', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });

    it('P1-10: extracts inherited field using declaringClass anchor (primary lookup, no fallback)', () => {
        // The anchor now uses the declaring class (BaseEntity), not the concrete entity class.
        // The primary lookup sf.getClass('BaseEntity').getProperty('created_at') works directly.
        const project = inMemoryProject({
            '/libs/nest-shared/src/db/entities/base-entity.ts': `
import { Column, CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn()
  created_at: Date;
}
`,
        });
        const node = makeNode({
            id: 'db-entity-field:ai_admin_users/created_at',
            kind: 'db-entity-field',
            label: 'ai_admin_users/created_at',
            // path points to the base-entity file (where the declaring class lives)
            path: '/libs/nest-shared/src/db/entities/base-entity.ts',
            // anchor uses declaringClass — the class that actually owns @CreateDateColumn
            anchor: buildAnchor('BaseEntity.created_at', 'test'),
        });
        const result = extractSnippet(project, node);
        // Primary lookup succeeds — no fallback needed
        expect(result.reason).toBeUndefined();
        expect(result.snippet).toContain('created_at');
        expect(result.snippet).toContain('@CreateDateColumn');
    });

    it('returns label-not-located when anchor class does not exist (no silent first-match fallback)', () => {
        // Negative test: anchor references a class that is not in the file.
        // Under the old kludge, this would silently return a snippet from the first
        // class that happened to have a matching property name.
        // With the fallback removed, it must return label-not-located.
        const project = inMemoryProject({
            '/libs/db/src/real.entity.ts': `
import { Column } from 'typeorm';
export class Real {
  @Column()
  foo: string;
}
`,
        });
        const node = makeNode({
            id: 'db-entity-field:table/foo',
            kind: 'db-entity-field',
            label: 'table/foo',
            path: '/libs/db/src/real.entity.ts',
            // NonExistent is not in the file — only Real is
            anchor: buildAnchor('NonExistent.foo', 'test'),
        });
        const result = extractSnippet(project, node);
        // Must not silently return Real.foo
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });
});

// ---------------------------------------------------------------------------
// config-field — kind-aware (A3 + A8)
// ---------------------------------------------------------------------------

describe('extractSnippet — config-field kind', () => {
    it('extracts a window around configService.get call', () => {
        const project = inMemoryProject({
            '/apps/auth/src/auth.config.ts': `
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthConfig {
  constructor(private readonly configService: ConfigService) {}

  get jwtSecret() {
    return this.configService.get<string>('JWT_SECRET');
  }
}
`,
        });
        const node = makeNode({
            id: 'config-field:JWT_SECRET',
            kind: 'config-field',
            label: 'JWT_SECRET',
            path: '/apps/auth/src/auth.config.ts',
            anchor: buildAnchor('JWT_SECRET', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('JWT_SECRET');
        expect(result.reason).toBeUndefined();
    });

    it('extracts a window around process.env access', () => {
        const project = inMemoryProject({
            '/apps/api/src/config.ts': `
const port = process.env.PORT ?? 3000;
const host = process.env.HOST ?? 'localhost';
`,
        });
        const node = makeNode({
            id: 'config-field:PORT',
            kind: 'config-field',
            label: 'PORT',
            path: '/apps/api/src/config.ts',
            anchor: buildAnchor('PORT', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('PORT');
        expect(result.reason).toBeUndefined();
    });

    it('returns label-not-located when key not in file', () => {
        const project = inMemoryProject({
            '/apps/api/src/config.ts': `const x = 1;`,
        });
        const node = makeNode({
            id: 'config-field:MISSING_KEY',
            kind: 'config-field',
            label: 'MISSING_KEY',
            path: '/apps/api/src/config.ts',
            anchor: buildAnchor('MISSING_KEY', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('label-not-located');
    });
});

// ---------------------------------------------------------------------------
// fe-component — kind-aware (A6 + A8) with JSDoc + JSX text
// ---------------------------------------------------------------------------

describe('extractSnippet — fe-component kind', () => {
    it('extracts arrow-function component with JSDoc', () => {
        const project = inMemoryProject({
            '/apps/web/src/button.tsx': `
/** A reusable button component. */
export const Button = ({ label }: { label: string }) => {
  return <button>{label}</button>;
};
`,
        });
        const node = makeNode({
            id: 'fe-component:/apps/web/src/button.tsx#Button',
            kind: 'fe-component',
            label: 'Button',
            path: '/apps/web/src/button.tsx',
            anchor: buildAnchor('Button', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('Button');
        expect(result.reason).toBeUndefined();
    });

    it('uses relaxed cap FE_SNIPPET_MAX_CHARS for fe-component', () => {
        const longJsxText = 'x'.repeat(300);
        const project = inMemoryProject({
            '/apps/web/src/big.tsx': `
/** JSDoc comment here. */
export const BigComponent = () => {
  const body = "${longJsxText}";
  return <div>{body}</div>;
};
`,
        });
        const node = makeNode({
            id: 'fe-component:/apps/web/src/big.tsx#BigComponent',
            kind: 'fe-component',
            label: 'BigComponent',
            path: '/apps/web/src/big.tsx',
            anchor: buildAnchor('BigComponent', 'test'),
        });
        const result = extractSnippet(project, node);
        // Should be capped at FE_SNIPPET_MAX_CHARS, not SNIPPET_MAX_CHARS
        expect(result.snippet.length).toBeLessThanOrEqual(FE_SNIPPET_MAX_CHARS);
        expect(result.snippet).toContain('BigComponent');
    });

    it('extracts function declaration component', () => {
        const project = inMemoryProject({
            '/apps/web/src/header.tsx': `
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}
`,
        });
        const node = makeNode({
            id: 'fe-component:/apps/web/src/header.tsx#Header',
            kind: 'fe-component',
            label: 'Header',
            path: '/apps/web/src/header.tsx',
            anchor: buildAnchor('Header', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('Header');
        expect(result.reason).toBeUndefined();
    });

    it('P0-1: includes JSDoc text and JSX text content in snippet', () => {
        // This test asserts that the [jsDocText, declText, jsxText].filter(Boolean).join('\n')
        // concatenation in snippet.ts actually produces all three parts.
        const project = inMemoryProject({
            '/apps/web/src/save-avatar.tsx': `
/** Displays user avatar with a Save button. */
export const SaveAvatar = ({ name }: { name: string }) => (
  <div className="truncate">
    <span>Сохранить</span>
    <button>{name}</button>
  </div>
);
`,
        });
        const node = makeNode({
            id: 'fe-component:/apps/web/src/save-avatar.tsx#SaveAvatar',
            kind: 'fe-component',
            label: 'SaveAvatar',
            path: '/apps/web/src/save-avatar.tsx',
            anchor: buildAnchor('SaveAvatar', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.reason).toBeUndefined();
        // JSDoc must be present
        expect(result.snippet).toContain('Displays user avatar');
        // JSX text content must be present
        expect(result.snippet).toContain('Сохранить');
        // Optional: className attribute (bonus)
        expect(result.snippet).toContain('truncate');
    });
});

// ---------------------------------------------------------------------------
// fe-hook — kind-aware
// ---------------------------------------------------------------------------

describe('extractSnippet — fe-hook kind', () => {
    it('extracts hook function by name', () => {
        const project = inMemoryProject({
            '/apps/web/src/use-auth.ts': `
export function useAuth() {
  return { user: null };
}
`,
        });
        const node = makeNode({
            id: 'fe-hook:/apps/web/src/use-auth.ts#useAuth',
            kind: 'fe-hook',
            label: 'useAuth',
            path: '/apps/web/src/use-auth.ts',
            anchor: buildAnchor('useAuth', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('useAuth');
        expect(result.reason).toBeUndefined();
    });

    it('falls back to variable declaration', () => {
        const project = inMemoryProject({
            '/apps/web/src/use-toggle.ts': `
export const useToggle = (initial = false) => {
  let state = initial;
  return { state, toggle: () => { state = !state; } };
};
`,
        });
        const node = makeNode({
            id: 'fe-hook:/apps/web/src/use-toggle.ts#useToggle',
            kind: 'fe-hook',
            label: 'useToggle',
            path: '/apps/web/src/use-toggle.ts',
            anchor: buildAnchor('useToggle', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('useToggle');
        expect(result.reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// fe-route — kind-aware: scan exported functions when no anchor/default export
// ---------------------------------------------------------------------------

describe('extractSnippet — fe-route kind', () => {
    it('extracts exported function when no anchor is set (App Router page pattern)', () => {
        const project = inMemoryProject({
            '/apps/web/src/pages/dashboard/page.tsx': `
export function DashboardPage() {
    return <main>Dashboard</main>;
}
`,
        });
        const node = makeNode({
            id: 'fe-route:/dashboard',
            kind: 'fe-route',
            label: '/dashboard',
            path: '/apps/web/src/pages/dashboard/page.tsx',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('DashboardPage');
        expect(result.reason).toBeUndefined();
    });

    it('uses anchor when set to find the component by name', () => {
        const project = inMemoryProject({
            '/apps/web/src/pages/settings.tsx': `
export const SettingsPage = () => <div>Settings</div>;
`,
        });
        const node = makeNode({
            id: 'fe-route:/settings',
            kind: 'fe-route',
            label: '/settings',
            path: '/apps/web/src/pages/settings.tsx',
            anchor: buildAnchor('SettingsPage', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('SettingsPage');
        expect(result.reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// module — has path + anchor set (ensureModuleNode)
// ---------------------------------------------------------------------------

describe('extractSnippet — module kind', () => {
    it('extracts @Module-decorated class text via anchor', () => {
        const project = inMemoryProject({
            '/apps/auth/src/auth.module.ts': `
import { Module } from '@nestjs/common';
@Module({ providers: [] })
export class AuthModule {}
`,
        });
        const node = makeNode({
            id: 'module:AuthModule',
            kind: 'module',
            label: 'AuthModule',
            path: '/apps/auth/src/auth.module.ts',
            anchor: buildAnchor('AuthModule', 'test'),
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toContain('AuthModule');
        expect(result.reason).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Nodes without path — unchanged behaviour
// ---------------------------------------------------------------------------

describe('extractSnippet — nodes without path (no regression)', () => {
    it('returns empty snippet and no reason for nats-subject', () => {
        const project = inMemoryProject({});
        const node = makeNode({ id: 'n1', kind: 'nats-subject', label: 'agent.events' });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeUndefined();
    });

    it('returns empty snippet and no reason for db-table', () => {
        const project = inMemoryProject({});
        const node = makeNode({ id: 'n2', kind: 'db-table', label: 'users' });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason).toBeUndefined();
    });

    it('returns file-not-found when path not in project', () => {
        const project = inMemoryProject({});
        const node = makeNode({
            id: 'service:Missing',
            kind: 'service',
            label: 'Missing',
            path: '/no/such/file.ts',
        });
        const result = extractSnippet(project, node);
        expect(result.snippet).toBe('');
        expect(result.reason?.kind).toBe('file-not-found');
    });

    it('never throws', () => {
        const project = inMemoryProject({});
        const node = makeNode({
            id: 'weird',
            kind: 'external',
            label: '',
            path: '/nonexistent.ts',
        });
        expect(() => extractSnippet(project, node)).not.toThrow();
    });
});
