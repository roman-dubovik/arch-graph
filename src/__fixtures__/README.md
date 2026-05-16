# Test fixtures — pattern

Every extractor test in arch-graph follows the same shape: an **in-memory**
`ts-morph` `Project` with one or two synthetic `.ts` files added as strings,
fed to the extractor under test. No filesystem, no real monorepo dependency,
no snapshot-based brittleness.

## Why in-memory

- **Hermetic**: tests don't need configs/*.local.ts. They run on CI without secrets.
- **Fast**: vitest + ts-morph in-memory parses a 20-line synthetic file in <1 ms.
- **Targeted**: each test asserts one shape (one decorator, one cycle, one alias).

## Minimal example

```ts
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { extractDi } from '../di/extractor.js';

function inMemoryProject(files: Record<string, string>): Project {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}

describe('di extractor — minimal smoke', () => {
    it('captures a @Module decorator', async () => {
        const project = inMemoryProject({
            '/src/app.module.ts': `
                import { Module } from '@nestjs/common';
                @Module({ imports: [] })
                export class AppModule {}
            `,
        });
        const result = await extractDi(
            { root: '/src', /* … minimal config — see existing tests */ } as any,
            project,
        );
        expect(result.modules.map((m) => m.className)).toContain('AppModule');
    });
});
```

## Conventions

- Test files live next to the code they exercise: `src/extractors/foo/extractor.ts`
  → `src/extractors/foo/extractor.test.ts`.
- File paths inside `useInMemoryFileSystem` should look like absolute
  POSIX paths (`/src/app.ts`) — the extractors expect absolute paths.
- For owner resolution (`apps/` vs `libs/`) use `/apps/<svc>/...` and
  `/libs/<lib>/...` to match the same heuristic used in real projects.
- Coverage threshold is **95% lines / 95% statements / 95% functions /
  90% branches** per file (see `vitest.config.ts`). Each new extractor
  adds its source files to `coverage.thresholds.include`.
