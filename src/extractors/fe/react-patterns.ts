/**
 * React component and hook detection from a ts-morph SourceFile.
 *
 * Detects:
 *   - Arrow function components:   const X = () => <JSX/>
 *   - Function declaration comps:  function X() { return <JSX/>; }
 *   - Class components:            class X extends React.Component / PureComponent
 *   - React.memo wrappers:         const X = React.memo(...)
 *   - React.forwardRef wrappers:   const X = React.forwardRef(...)
 *   - Custom hooks:                name matches /^use[A-Z]/ AND body calls another use*
 */

import {
    ArrowFunction,
    FunctionDeclaration,
    Node,
    SourceFile,
    SyntaxKind,
} from 'ts-morph';

import type { FeComponent, FeHook, FeRender } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns true if the node (or any descendant) contains a JSX element/fragment. */
function containsJsx(node: Node): boolean {
    if (
        node.getKind() === SyntaxKind.JsxElement ||
        node.getKind() === SyntaxKind.JsxSelfClosingElement ||
        node.getKind() === SyntaxKind.JsxFragment
    ) {
        return true;
    }
    return node.getChildren().some(containsJsx);
}

/** Returns true if the function/arrow body calls any hook (use[A-Z]*). */
function bodyCallsHook(node: ArrowFunction | FunctionDeclaration): boolean {
    const body = node.getBody();
    /* v8 ignore next 1 */ if (!body) return false;
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);
    return calls.some((c) => /^use[A-Z]/.test(c.getExpression().getText()));
}

/**
 * Returns true if the given node's containing VariableStatement has an `export` keyword,
 * and false if the statement has `export default` or no export.
 */
function varStatementIsNamed(node: Node): { exported: boolean; defaultExport: boolean } {
    // node is VariableDeclaration → parent is VariableDeclarationList → parent is VariableStatement
    const stmt = node.getParent()?.getParent();
    /* v8 ignore next 3 */
    if (!stmt || stmt.getKind() !== SyntaxKind.VariableStatement) {
        return { exported: false, defaultExport: false };
    }
    /* v8 ignore next 1 */
    const mods = stmt.getModifiers() ?? [];
    const exported = mods.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.getKind() === SyntaxKind.DefaultKeyword);
    return { exported, defaultExport: isDefault };
}

/**
 * Collect rendered component names (uppercase JSX tags) from a node subtree.
 * Used to build per-component render references.
 */
function collectRenderedNames(node: Node): Set<string> {
    const names = new Set<string>();
    for (const jsxEl of node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
        const tagName = jsxEl.getTagNameNode().getText();
        if (/^[A-Z]/.test(tagName)) names.add(tagName);
    }
    for (const jsxSelf of node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
        const tagName = jsxSelf.getTagNameNode().getText();
        if (/^[A-Z]/.test(tagName)) names.add(tagName);
    }
    return names;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReactExtractionResult {
    components: FeComponent[];
    hooks: FeHook[];
    renders: FeRender[];
}

export interface ReactExtractionOptions {
    /** When true, only extract hooks and skip component/render detection. */
    hooksOnly: boolean;
}

/**
 * Scan one SourceFile for React components, hooks, and JSX render references.
 */
export function extractReactPatterns(
    sf: SourceFile,
    options: ReactExtractionOptions = { hooksOnly: false },
): ReactExtractionResult {
    const file = sf.getFilePath();
    const components: FeComponent[] = [];
    const hooks: FeHook[] = [];
    const renders: FeRender[] = [];
    const seenComponents = new Set<string>();

    // -----------------------------------------------------------------------
    // 1. Variable declarations: arrow components, memo/forwardRef, and arrow hooks
    // -----------------------------------------------------------------------
    for (const varDecl of sf.getVariableDeclarations()) {
        const init = varDecl.getInitializer();
        if (!init) continue;
        const name = varDecl.getName();

        // ---- React.memo(...) wrapper ----
        if (!options.hooksOnly && Node.isCallExpression(init)) {
            const callText = init.getExpression().getText();
            if (callText === 'React.memo' || callText === 'memo') {
                const { exported, defaultExport } = varStatementIsNamed(varDecl);
                if (!seenComponents.has(name)) {
                    seenComponents.add(name);
                    const { line, column } = sf.getLineAndColumnAtPos(varDecl.getStart());
                    const comp: FeComponent = {
                        name,
                        kind: 'memo',
                        file,
                        location: { file, line, column },
                        exported: exported || defaultExport,
                        defaultExport,
                    };
                    components.push(comp);
                    // memo wraps an inner node — collect renders from the entire init
                    const renderedNames = collectRenderedNames(init);
                    for (const toName of renderedNames) {
                        renders.push({ fromFile: file, fromName: name, toName, location: { file, line, column } });
                    }
                }
                continue;
            }

            // ---- React.forwardRef(...) wrapper ----
            if (callText === 'React.forwardRef' || callText === 'forwardRef') {
                const { exported, defaultExport } = varStatementIsNamed(varDecl);
                if (!seenComponents.has(name)) {
                    seenComponents.add(name);
                    const { line, column } = sf.getLineAndColumnAtPos(varDecl.getStart());
                    const comp: FeComponent = {
                        name,
                        kind: 'forwardRef',
                        file,
                        location: { file, line, column },
                        exported: exported || defaultExport,
                        defaultExport,
                    };
                    components.push(comp);
                    const renderedNames = collectRenderedNames(init);
                    for (const toName of renderedNames) {
                        renders.push({ fromFile: file, fromName: name, toName, location: { file, line, column } });
                    }
                }
                continue;
            }
        }

        // ---- Arrow function hook (const useX = ...) ----
        if (Node.isArrowFunction(init) && /^use[A-Z]/.test(name)) {
            if (bodyCallsHook(init)) {
                const { line, column } = sf.getLineAndColumnAtPos(varDecl.getStart());
                hooks.push({ name, file, location: { file, line, column } });
            }
            continue;
        }

        if (options.hooksOnly) continue;

        // ---- Arrow function component ----
        if (!Node.isArrowFunction(init)) continue;
        if (!/^[A-Z]/.test(name)) continue;
        if (!containsJsx(init)) continue;

        const { exported, defaultExport } = varStatementIsNamed(varDecl);
        if (!seenComponents.has(name)) {
            seenComponents.add(name);
            const { line, column } = sf.getLineAndColumnAtPos(varDecl.getStart());
            components.push({
                name,
                kind: 'arrow',
                file,
                location: { file, line, column },
                exported: exported || defaultExport,
                defaultExport,
            });
            // Scope renders to this component's arrow body (P1-1)
            const renderedNames = collectRenderedNames(init);
            for (const toName of renderedNames) {
                renders.push({ fromFile: file, fromName: name, toName, location: { file, line, column } });
            }
        }
    }

    // -----------------------------------------------------------------------
    // 2. Function declaration components and function hooks
    // -----------------------------------------------------------------------
    for (const fn of sf.getFunctions()) {
        const name = fn.getName();
        /* v8 ignore next 1 */
        if (!name) continue;

        // Hook: use[A-Z]* with hook body calls
        if (/^use[A-Z]/.test(name)) {
            if (bodyCallsHook(fn)) {
                const { line, column } = sf.getLineAndColumnAtPos(fn.getStart());
                hooks.push({ name, file, location: { file, line, column } });
            }
            continue;
        }

        if (options.hooksOnly) continue;

        // Component: uppercase name, body returns JSX
        if (!/^[A-Z]/.test(name)) continue;
        if (!containsJsx(fn)) continue;

        /* v8 ignore next 1 */
        const mods = fn.getModifiers() ?? [];
        const exported = mods.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
        const defaultExport = mods.some((m) => m.getKind() === SyntaxKind.DefaultKeyword);

        if (!seenComponents.has(name)) {
            seenComponents.add(name);
            const { line, column } = sf.getLineAndColumnAtPos(fn.getStart());
            components.push({
                name,
                kind: 'function',
                file,
                location: { file, line, column },
                exported: exported || defaultExport,
                defaultExport,
            });
            // Scope renders to this function body (P1-1)
            const renderedNames = collectRenderedNames(fn);
            for (const toName of renderedNames) {
                renders.push({ fromFile: file, fromName: name, toName, location: { file, line, column } });
            }
        }
    }

    // -----------------------------------------------------------------------
    // 3. Class components: class X extends React.Component / React.PureComponent
    // -----------------------------------------------------------------------
    if (!options.hooksOnly) {
        for (const cls of sf.getClasses()) {
            const extendsExpr = cls.getExtends()?.getExpression().getText() ?? '';
            if (
                extendsExpr !== 'React.Component' &&
                extendsExpr !== 'React.PureComponent' &&
                extendsExpr !== 'Component' &&
                extendsExpr !== 'PureComponent'
            ) {
                continue;
            }

            const name = cls.getName();
            /* v8 ignore next 1 */
            if (!name) continue;

            /* v8 ignore next 1 */
            const mods = cls.getModifiers() ?? [];
            const exported = mods.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
            const defaultExport = mods.some((m) => m.getKind() === SyntaxKind.DefaultKeyword);

            if (!seenComponents.has(name)) {
                seenComponents.add(name);
                const { line, column } = sf.getLineAndColumnAtPos(cls.getStart());
                components.push({
                    name,
                    kind: 'class',
                    file,
                    location: { file, line, column },
                    exported: exported || defaultExport,
                    defaultExport,
                });
                // Scope renders to the class body (P1-1)
                const renderedNames = collectRenderedNames(cls);
                for (const toName of renderedNames) {
                    renders.push({ fromFile: file, fromName: name, toName, location: { file, line, column } });
                }
            }
        }
    }

    return { components, hooks, renders };
}
