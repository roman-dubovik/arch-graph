/**
 * Anchor factory for "Class.member" graph node anchors.
 *
 * A node anchor is the string used by snippet extractors to locate the source
 * declaration for a graph node (e.g. "UserService.findById").  Bad anchors —
 * empty class names, empty member names, or sentinel values like `<anonymous>`
 * — produce silent empty snippets downstream.  This factory rejects them at
 * build time so the failure is loud and traceable.
 */

/**
 * Build a "Class.member" anchor for a graph node. Rejects empty or
 * sentinel member names like `<anonymous>` at build time so that
 * downstream snippet extraction never silently produces empty snippets.
 *
 * @param className   Name of the owning class (e.g. "UserController").
 * @param memberName  Name of the method or property (e.g. "findOne").
 * @param nodeId      Node ID used in the error message for traceability.
 * @returns           "className.memberName" anchor string.
 * @throws            If className is empty, memberName is empty, or
 *                    memberName is the sentinel value `<anonymous>`.
 */
export function buildClassMemberAnchor(
    className: string,
    memberName: string,
    nodeId: string,
): string {
    if (!className.trim()) {
        throw new Error(`anchor: className is empty for ${nodeId}`);
    }
    if (!memberName.trim() || memberName === '<anonymous>') {
        throw new Error(`anchor: memberName is invalid for ${nodeId} (got '${memberName}')`);
    }
    return `${className}.${memberName}`;
}
