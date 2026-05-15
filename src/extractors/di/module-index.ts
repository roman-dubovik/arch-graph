import { Project, SourceFile } from 'ts-morph';

import { isExcludedSourceFile } from '../shared.js';

/**
 * Pre-pass: catalogues every class decorated with `@Module(...)` in the project,
 * keyed by class name. Lets the DI extractor distinguish "known local module"
 * from "external module reference" (e.g. a NestJS built-in like `TypeOrmModule`
 * or `ConfigModule` brought in from `node_modules`).
 *
 * Stored info is intentionally minimal (file + line). The richer per-module data
 * — imports/providers/exports — is produced by the main extractor pass; making
 * this a separate pre-pass keeps it cheap and re-usable.
 *
 * Class-name collisions across files are tolerated (last one wins for location).
 * The graph collapses by node id anyway; this index only governs the `meta.local`
 * flag on module nodes.
 */
export class DiModuleIndex {
    private byName = new Map<string, { file: string; line: number }>();

    has(className: string): boolean {
        return this.byName.has(className);
    }
    get(className: string): { file: string; line: number } | undefined {
        return this.byName.get(className);
    }
    size(): number {
        return this.byName.size;
    }
    set(className: string, loc: { file: string; line: number }): void {
        this.byName.set(className, loc);
    }
}

export function buildDiModuleIndex(project: Project): DiModuleIndex {
    const idx = new DiModuleIndex();
    for (const sf of project.getSourceFiles()) {
        if (isExcludedForIndex(sf)) continue;
        // Fast-path: skip files that don't contain `@Module(` at all. Saves ~50% of
        // wall time on monorepos where most files have no decorators.
        if (!sf.getFullText().includes('@Module')) continue;

        for (const cls of sf.getClasses()) {
            const dec = cls.getDecorator('Module');
            if (!dec) continue;
            const name = cls.getName();
            if (!name) continue; // anonymous default-export @Module — rare; skip
            const pos = sf.getLineAndColumnAtPos(dec.getStart());
            idx.set(name, { file: sf.getFilePath(), line: pos.line });
        }
    }
    return idx;
}

function isExcludedForIndex(sf: SourceFile): boolean {
    if (isExcludedSourceFile(sf)) return true;
    // Defensive: never index node_modules even if the shared filter changed.
    return sf.getFilePath().includes('/node_modules/');
}
