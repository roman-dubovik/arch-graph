import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { extractCodeIntel } from './extractor';

const FIXTURE_ROOT = new URL(
    '__fixtures__/heritage',
    import.meta.url,
).pathname;

describe('extractCodeIntel — heritage v1 (acceptance: on-disk fixture monorepo)', () => {
    it('extracts the fixture monorepo and verifies end-to-end heritage relationships', () => {
        const project = new Project({
            tsConfigFilePath: undefined,
            compilerOptions: {
                target: 99,
                module: 99,
                moduleResolution: 100,
                strict: true,
                esModuleInterop: true,
            },
        });

        // Add all fixture files from the on-disk hierarchy
        project.addSourceFilesAtPaths(
            `${FIXTURE_ROOT}/**/*.ts`,
        );

        const index = extractCodeIntel(project, { root: FIXTURE_ROOT });

        // --- Assertion 1: AreaController.extendsClass points at BaseController.id
        const areaController = index.symbols.find(
            (s) => s.fqn === 'AreaController' && s.kind === 'class',
        );
        const baseController = index.symbols.find(
            (s) => s.fqn === 'BaseController' && s.kind === 'class',
        );

        expect(areaController).toBeDefined();
        expect(baseController).toBeDefined();
        expect(areaController?.extendsClass).toBe(baseController!.id);

        // --- Assertion 2: AreaController.create.overrideKind === 'delegation',
        // inheritsFrom === BaseController.create.id
        const areaCreate = index.symbols.find(
            (s) => s.fqn === 'AreaController.create' && s.kind === 'method',
        );
        const baseCreate = index.symbols.find(
            (s) => s.fqn === 'BaseController.create' && s.kind === 'method',
        );

        expect(areaCreate).toBeDefined();
        expect(baseCreate).toBeDefined();
        expect(areaCreate?.overrideKind).toBe('delegation');
        expect(areaCreate?.inheritsFrom).toBe(baseCreate!.id);

        // --- Assertion 3: AuditController (3-level chain):
        // its extendsClass points at ProtectedController,
        // AND at least one of its methods has overrideKind: 'replaced'
        const auditController = index.symbols.find(
            (s) => s.fqn === 'AuditController' && s.kind === 'class',
        );
        const protectedController = index.symbols.find(
            (s) => s.fqn === 'ProtectedController' && s.kind === 'class',
        );

        expect(auditController).toBeDefined();
        expect(protectedController).toBeDefined();
        expect(auditController?.extendsClass).toBe(protectedController!.id);

        // ProtectedController should extend BaseController (verify the chain)
        expect(protectedController?.extendsClass).toBe(baseController!.id);

        // AuditController.delete should be 'replaced' (no super call)
        const auditDelete = index.symbols.find(
            (s) => s.fqn === 'AuditController.delete' && s.kind === 'method',
        );
        expect(auditDelete?.overrideKind).toBe('replaced');

        // --- Assertion 4: EngagementController has at least one augmented method
        const engagementCreate = index.symbols.find(
            (s) => s.fqn === 'EngagementController.create' && s.kind === 'method',
        );
        const engagementUpdate = index.symbols.find(
            (s) => s.fqn === 'EngagementController.update' && s.kind === 'method',
        );

        // create has console.log + super → augmented
        // update has if check + super → augmented
        expect(engagementCreate?.overrideKind).toBe('augmented');
        expect(engagementUpdate?.overrideKind).toBe('augmented');

        // --- Optional: super-call edges
        // At least one delegation super-call should exist from AreaController.create
        const superCallEdge = index.calls.find(
            (c) =>
                c.callerId === areaCreate!.id &&
                c.calleeId === baseCreate!.id &&
                c.kind === 'super-call',
        );
        expect(superCallEdge).toBeDefined();
        if (superCallEdge) {
            expect(superCallEdge.expression).toMatch(/super\.create/);
        }
    });
});
