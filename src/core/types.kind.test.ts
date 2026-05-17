import { describe, it, expect } from 'vitest';
import { NODE_KIND_VALUES } from './types.js';

describe('NodeKind taxonomy', () => {
    it('includes doc-section', () => {
        expect(NODE_KIND_VALUES).toContain('doc-section');
    });
});
