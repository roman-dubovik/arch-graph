/**
 * P1-M: fileSizeBytes EACCES rethrow test.
 *
 * Isolated from io.test.ts because vi.mock('node:fs/promises') is file-scoped
 * and would break the real-I/O tests in io.test.ts.
 *
 * fileSizeBytes must only swallow ENOENT (file absent is expected).
 * Any other error code — including EACCES (permission denied) — must be
 * rethrown so the caller sees the real failure.
 */
import { describe, expect, it, vi } from 'vitest';

// Mock node:fs/promises so we can inject a controlled EACCES error.
// This must be at file top (vi.mock is hoisted).
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        stat: vi.fn(),
    };
});

import { stat } from 'node:fs/promises';
import { fileSizeBytes } from './io.js';

describe('fileSizeBytes — EACCES rethrow (P1-M)', () => {
    it('rethrows when stat throws EACCES (not ENOENT)', async () => {
        const eaccesErr = Object.assign(new Error('EACCES: permission denied, stat \'/some/path\''), {
            code: 'EACCES',
        });
        vi.mocked(stat).mockRejectedValueOnce(eaccesErr);

        await expect(fileSizeBytes('/some/path')).rejects.toThrow('EACCES');
    });

    it('returns 0 when stat throws ENOENT (file absent is expected)', async () => {
        const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), {
            code: 'ENOENT',
        });
        vi.mocked(stat).mockRejectedValueOnce(enoentErr);

        const size = await fileSizeBytes('/missing/path');
        expect(size).toBe(0);
    });
});
