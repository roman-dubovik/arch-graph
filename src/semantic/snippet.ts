/**
 * Extracts a short source snippet for a GraphNode using ts-morph.
 *
 * Snippet length is capped at {@link SNIPPET_MAX_CHARS} (400 chars).
 * Nodes without a `path` (e.g. `nats-subject`, `db-table`) return an empty
 * snippet without a `reason` — that is expected behaviour, not a failure.
 *
 * Contract: **never throws**. All failure modes are returned as values with
 * a structured `reason` string so callers can record them in diagnostics.
 */
import type { Project } from 'ts-morph';

import type { GraphNode } from '../core/types.js';

/** Maximum characters returned in a snippet. */
export const SNIPPET_MAX_CHARS = 400;

export interface SnippetResult {
    snippet: string;
    /** Set only when extraction failed for a recoverable reason. */
    reason?: string;
}

/**
 * Extract a representative source snippet for `node` from the ts-morph
 * `project`. Returns an empty snippet (no `reason`) for nodes with no `path`
 * — embedding `label + kind` alone still has value for those anchors.
 *
 * Never throws: all errors become `{ snippet: '', reason: '<message>' }`.
 */
export function extractSnippet(project: Project, node: GraphNode): SnippetResult {
    // Nodes with no path have no source to extract; expected, not a failure.
    if (!node.path) {
        return { snippet: '' };
    }

    try {
        const sourceFile = project.getSourceFile(node.path);
        if (!sourceFile) {
            return { snippet: '', reason: `file-not-found: ${node.path}` };
        }

        // Try to find a declaration that matches the node's label.
        // We look for: class, function, interface, type alias, variable.
        const declaration =
            sourceFile.getClass(node.label) ??
            sourceFile.getFunction(node.label) ??
            sourceFile.getInterface(node.label) ??
            sourceFile.getTypeAlias(node.label) ??
            sourceFile.getVariableDeclaration(node.label);

        if (declaration) {
            const text = declaration.getText();
            return { snippet: text.slice(0, SNIPPET_MAX_CHARS) };
        }

        // Label not found in this file — return empty snippet with reason.
        return { snippet: '', reason: `label-not-located: ${node.label}` };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { snippet: '', reason: `ts-morph-error: ${message}` };
    }
}
