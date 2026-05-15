import type { ArchGraphConfig } from '../core/config.js';
import type {
    ImportsGroundTruthEntry,
    ImportsValidationReport,
    TsImportSite,
} from '../core/types.js';
import { buildLineStarts, offsetToLineCol } from './line-index.js';
import { iterateSourceFiles } from './scan.js';
import { stripComments } from './strip-comments.js';

/**
 * Ground-truth grep for TS-imports. Counts every `^import ...` declaration
 * per file (static imports only — dynamic `import(...)` is excluded because
 * the regex shape is `import(`, not `import ` followed by identifier/{).
 *
 * Per-file matching: unlike NATS/TypeORM/BullMQ (which match GT entries to
 * extracted sites by file:line), imports recall is checked as a count-equality
 * per file. Why:
 *   - The number of `import` lines per file is small (median ~5), so a count
 *     comparison is reliable.
 *   - Line-by-line matching would penalize harmless re-orderings (formatters
 *     can split a multi-line import across lines, shifting the regex offset).
 *   - The minPerFileRecall metric catches the wholesale "this file's imports
 *     all vanished" regression that an aggregate average would dilute.
 */

// Captures: `import ... from '...'`, `import type { ... } from '...'`,
// `import * as X from '...'`. Multiline imports (`import {\n  A,\n  B\n} from '...'`)
// must be counted too — earlier draft used `[^;\n]*?` which excluded newlines and
// missed multi-line forms (silently undercounting GT and inflating recall). We use
// `[\s\S]*?` (lazy any-char) and anchor on `^\s*import\s+` at line start.
//
// `m` flag — `^` matches each line start.
// `s` flag — `.` matches newlines (we use `[\s\S]` to be explicit, but `s` doesn't hurt).
//
// We deliberately don't capture the specifier here — the validator only counts.
const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?!['"`])[\s\S]*?from\s+['"`][^'"`]+['"`]/gm;
// Side-effect-only: `import './foo';`. Separate regex because `from` is absent.
// The negative lookahead in IMPORT_RE (`(?!['"`])`) keeps these from double-matching.
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"`][^'"`]+['"`]\s*;?/gm;

export async function enumerateImportsGroundTruth(
    cfg: ArchGraphConfig,
): Promise<Map<string, ImportsGroundTruthEntry[]>> {
    // Returns the per-file entry map (file path → GT entries). `buildImportsReport`
    // consumes this directly: per-file iteration powers `minPerFileRecall`, and the
    // total count is the sum of all entries across files.
    const out = new Map<string, ImportsGroundTruthEntry[]>();

    for await (const { file, content } of iterateSourceFiles(cfg, 'imports GT')) {
        if (!content.includes('import')) continue;

        const stripped = stripComments(content);
        const lineStarts = buildLineStarts(stripped);
        const entries: ImportsGroundTruthEntry[] = [];

        const push = (m: RegExpMatchArray): void => {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(offset, lineStarts);
            const matched = m[0];
            entries.push({
                role: 'static',
                location: { file, line, column },
                matchedText: matched.replace(/\n.*$/s, '').trim(),
                typeOnly: /^\s*import\s+type\b/.test(matched),
            });
        };

        for (const m of stripped.matchAll(IMPORT_RE)) push(m);
        // Side-effect imports — second pass. Filter overlap by start offset
        // (the from-form regex won't match these, but a paranoid guard is cheap).
        const seen = new Set<number>(entries.map((e) => e.location.line));
        for (const m of stripped.matchAll(SIDE_EFFECT_IMPORT_RE)) {
            const offset = m.index ?? 0;
            const { line } = offsetToLineCol(offset, lineStarts);
            if (seen.has(line)) continue;
            push(m);
        }

        if (entries.length > 0) out.set(file, entries);
    }

    return out;
}

export function buildImportsReport(
    sites: TsImportSite[],
    groundTruthByFile: Map<string, ImportsGroundTruthEntry[]>,
): ImportsValidationReport {
    // Count extracted STATIC imports per file. Dynamic imports aren't part of
    // the GT regex, so excluding them keeps the metric symmetric.
    const extractedByFile = new Map<string, number>();
    let totalStatic = 0;
    for (const s of sites) {
        if (s.kind !== 'static') continue;
        totalStatic++;
        extractedByFile.set(s.sourceFile, (extractedByFile.get(s.sourceFile) ?? 0) + 1);
    }

    let groundTruthStatic = 0;
    let minPerFileRecall = 1;
    const filesUnderRecall: Array<{ file: string; extracted: number; groundTruth: number }> = [];

    for (const [file, entries] of groundTruthByFile) {
        const gt = entries.length;
        groundTruthStatic += gt;
        const extracted = extractedByFile.get(file) ?? 0;
        // Per-file recall capped at 1 — extra extractions (multi-line cases the
        // regex couldn't see) shouldn't inflate the metric above 100%.
        const perFileRecall = gt === 0 ? 1 : Math.min(1, extracted / gt);
        if (perFileRecall < minPerFileRecall) minPerFileRecall = perFileRecall;
        if (extracted < gt) {
            filesUnderRecall.push({ file, extracted, groundTruth: gt });
        }
    }

    // Sort by recall gap descending (biggest misses first), cap at 20.
    filesUnderRecall.sort((a, b) => (b.groundTruth - b.extracted) - (a.groundTruth - a.extracted));

    return {
        summary: {
            recallStatic: groundTruthStatic > 0 ? Math.min(1, totalStatic / groundTruthStatic) : 1,
            minPerFileRecall: groundTruthByFile.size === 0 ? 1 : minPerFileRecall,
            totalStatic,
            groundTruthStatic,
            filesWithImports: groundTruthByFile.size,
            filesUnderRecall: filesUnderRecall.slice(0, 20),
        },
    };
}
