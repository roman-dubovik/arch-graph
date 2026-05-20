import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('install.sh interactive init handoff', () => {
    it('reattaches stdin to /dev/tty before launching init after a /dev/tty prompt', () => {
        const script = readFileSync(resolve('scripts/install.sh'), 'utf8');

        expect(script).toMatch(/if \[ "\$PROMPT_FD" = "tty" \]; then[\s\S]*exec "\$WRAPPER" init <\/dev\/tty/);
    });
});
