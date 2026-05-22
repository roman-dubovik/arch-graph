import { describe, expect, it } from 'vitest';
import { getFileOutline, resolveSymbol } from './queries.js';
import type { CodeIntelIndex, CodeIntelSymbol } from './types.js';

describe('code-intel queries', () => {
    const mockIndex: CodeIntelIndex = {
        manifest: { schemaVersion: 1, builtAt: '', root: '/root', counts: { symbols: 2, calls: 0, flows: 0, branches: 0, impacts: 0 } },
        symbols: [
            { id: 's1', kind: 'class', name: 'App', fqn: 'App', file: 'src/app.ts', line: 1, column: 1 },
            { id: 's2', kind: 'method', name: 'run', fqn: 'App.run', file: 'src/app.ts', line: 5, column: 5, parentId: 's1' },
            { id: 's3', kind: 'dto', name: 'UserDto', fqn: 'UserDto', file: 'libs/dto.ts', line: 10, column: 1 },
        ],
        calls: [],
        flows: [],
        branches: [],
        impacts: [],
    };

    describe('resolveSymbol', () => {
        it('resolves by exact name', () => {
            const result = resolveSymbol(mockIndex, 'UserDto');
            expect(result.found).toBe(true);
            expect(result.matches[0].fqn).toBe('UserDto');
        });

        it('resolves by partial path', () => {
            const result = resolveSymbol(mockIndex, 'libs/dto.ts');
            expect(result.found).toBe(true);
            expect(result.matches[0].name).toBe('UserDto');
        });

        it('resolves by fuzzy fqn', () => {
            const result = resolveSymbol(mockIndex, 'App.ru');
            expect(result.found).toBe(true);
            expect(result.matches[0].fqn).toBe('App.run');
        });
    });

    describe('getFileOutline', () => {
        it('returns all symbols in a file sorted by location', () => {
            const result = getFileOutline(mockIndex, { file: 'src/app.ts' });
            expect(result.found).toBe(true);
            expect(result.symbols.length).toBe(2);
            expect(result.symbols[0].name).toBe('App');
            expect(result.symbols[1].name).toBe('run');
        });

        it('handles missing files', () => {
            const result = getFileOutline(mockIndex, { file: 'non-existent.ts' });
            expect(result.found).toBe(false);
        });
    });
});
