/**
 * Class-name → file-path index for the DI and semantic layers.
 *
 * A lightweight pre-pass that walks all project source files and records the
 * absolute file path of every named class declaration. Used by:
 *   - `mapDiToGraph` to populate `path` + `anchor` on provider nodes (A1).
 *   - Potentially other mappers that receive only a class name and need the
 *     source location.
 *
 * Collision policy: first-seen wins (alphabetic file order is stable).
 */

import type { Project, SourceFile } from 'ts-morph';

import { isExcludedSourceFile } from '../shared.js';

export class ClassIndex {
    private byName = new Map<string, string>();

    /** Return the absolute file path for `className`, or `undefined` if not indexed. */
    get(className: string): string | undefined {
        return this.byName.get(className);
    }

    has(className: string): boolean {
        return this.byName.has(className);
    }

    size(): number {
        return this.byName.size;
    }

    /** Only used by the builder and tests — mappers call `get()` only. */
    _set(className: string, filePath: string): void {
        if (!this.byName.has(className)) {
            this.byName.set(className, filePath);
        }
    }
}

/** Build a ClassIndex from a ts-morph Project (production entry-point). */
export function buildClassIndex(project: Project): ClassIndex {
    const idx = new ClassIndex();
    // Sort source files for deterministic first-seen ordering.
    const files = [...project.getSourceFiles()].sort((a, b) =>
        a.getFilePath().localeCompare(b.getFilePath()),
    );
    for (const sf of files) {
        if (isExcludedForIndex(sf)) continue;
        for (const cls of sf.getClasses()) {
            const name = cls.getName();
            if (name) idx._set(name, sf.getFilePath());
        }
    }
    return idx;
}

function isExcludedForIndex(sf: SourceFile): boolean {
    if (isExcludedSourceFile(sf)) return true;
    return sf.getFilePath().includes('/node_modules/');
}
