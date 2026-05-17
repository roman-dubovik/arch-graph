/**
 * B8 — Scoped-marker stub test.
 *
 * Asserts the intentional no-op behaviour: empty markers array + diagnostic note.
 * This extractor is stub-by-design (see design doc § "Real-corpus signal").
 */

import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { extractScoped } from './extractor.js';

function emptyProject(): Project {
    return new Project({ useInMemoryFileSystem: true });
}

describe('extractScoped (stub)', () => {
    it('returns empty markers array', () => {
        const result = extractScoped(emptyProject());
        expect(result.markers).toHaveLength(0);
    });

    it('contains diagnostic note "stub-extractor, awaiting corpus signal"', () => {
        const result = extractScoped(emptyProject());
        const hasDiag = result.diagnostics.some((d) =>
            d.message.includes('stub-extractor, awaiting corpus signal'),
        );
        expect(hasDiag).toBe(true);
    });

    it('returns diagnostics even with a project that has source files', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/app/scoped-service.ts',
            `
import { Injectable, Scope } from '@nestjs/common';
@Injectable({ scope: Scope.REQUEST })
export class ScopedService {}
`,
        );
        const result = extractScoped(project);
        // Still stub — no markers emitted
        expect(result.markers).toHaveLength(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });
});
