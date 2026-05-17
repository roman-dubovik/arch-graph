/**
 * Anchor factory for "Class.member" graph node anchors.
 *
 * A node anchor is the string used by snippet extractors to locate the source
 * declaration for a graph node (e.g. "UserService.findById").  Bad anchors —
 * empty class names, empty member names, or sentinel values like `<anonymous>`
 * — produce silent empty snippets downstream.  This factory rejects them at
 * build time so the failure is loud and traceable.
 */

import type { Anchor } from '../core/types.js';

// Re-export so callers that only touch this module need a single import.
export type { Anchor };

/**
 * Build a bare-name anchor (e.g. a config key like `"JWT_SECRET"` or a class
 * name like `"AuthService"`) from an arbitrary string value.
 *
 * Validates that the value is non-empty and non-whitespace-only.  Use this
 * for anchor sites that are not "Class.member" form and would otherwise need
 * an `as Anchor` cast.
 *
 * @param value   The raw string to brand as an Anchor.
 * @param nodeId  Node ID used in the error message for traceability.
 * @returns       The value cast to `Anchor`.
 * @throws        If value is empty or whitespace-only.
 */
export function buildAnchor(value: string, nodeId: string): Anchor {
    if (!value.trim()) {
        throw new Error(`anchor: value is empty for ${nodeId}`);
    }
    return value as Anchor;
}

/**
 * Build a "Class.member" anchor for a graph node. Rejects empty or
 * sentinel member names like `<anonymous>` at build time so that
 * downstream snippet extraction never silently produces empty snippets.
 *
 * @param args.className   Name of the owning class (e.g. "UserController").
 * @param args.memberName  Name of the method or property (e.g. "findOne").
 * @param args.nodeId      Node ID used in the error message for traceability.
 * @returns                "className.memberName" anchor string branded as Anchor.
 * @throws                 If className is empty or whitespace-only; if memberName is empty,
 *                         whitespace-only, or the sentinel string `<anonymous>`.
 */
export function buildClassMemberAnchor(args: {
    className: string;
    memberName: string;
    nodeId: string;
}): Anchor {
    const { className, memberName, nodeId } = args;
    if (!className.trim()) {
        throw new Error(`anchor: className is empty for ${nodeId}`);
    }
    if (!memberName.trim() || memberName === '<anonymous>') {
        throw new Error(`anchor: memberName is invalid for ${nodeId} (got '${memberName}')`);
    }
    return `${className}.${memberName}` as Anchor;
}
