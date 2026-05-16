/**
 * FE-domain internal types.  Shared by extractor, mapper, and validator.
 * These are NOT exported from types.ts to keep the core schema thin.
 */

import type { SourceLoc } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Extractor output shapes
// ---------------------------------------------------------------------------

/** Detected kind of component definition. */
export type ComponentKind =
    | 'arrow'         // const X = () => <JSX/>
    | 'function'      // function X() { return <JSX/>; }
    | 'class'         // class X extends React.Component / PureComponent
    | 'memo'          // React.memo(X)
    | 'forwardRef';   // React.forwardRef(...)

export interface FeComponent {
    /** Component name (may be anonymous for memo/forwardRef wrapping unknown names). */
    name: string;
    kind: ComponentKind;
    /** File path on disk. */
    file: string;
    location: SourceLoc;
    /** True if `export default` or named export. */
    exported: boolean;
    /** True for default exports. */
    defaultExport: boolean;
}

export interface FeHook {
    /** Hook name, e.g. "useAuthState". */
    name: string;
    file: string;
    location: SourceLoc;
}

/**
 * A Next.js page (Pages Router) or App-Router page segment.
 * Carries the derived URL pattern.
 */
export interface FePage {
    /** Component / function name as declared in the file, or filename fallback. */
    name: string;
    file: string;
    location: SourceLoc;
    /** Derived URL pattern, e.g. `/users/:id`. */
    route: string;
    router: 'pages' | 'app';
}

/**
 * A route node — one per unique URL pattern.
 * Multiple pages may share the same pattern in edge cases; we deduplicate.
 */
export interface FeRoute {
    /** URL pattern, e.g. `/users/:id`. */
    pattern: string;
    /** Source page that declared this route. */
    pageFile: string;
}

/**
 * A React JSX render reference — component A renders component B.
 * B is referenced by its JSX tag identifier.
 */
export interface FeRender {
    /** Component that contains the JSX. */
    fromFile: string;
    fromName: string;
    /** Identifier used in JSX, e.g. `Button`. */
    toName: string;
    location: SourceLoc;
}

/**
 * A file-level import in a .tsx/.jsx file used to build `fe-imports` edges.
 * We only track local / aliased imports that could be components.
 */
export interface FeImportRef {
    /** Absolute path of the importing file. */
    sourceFile: string;
    /** Resolved absolute path of the imported file, or null if unresolved/external. */
    resolvedFile: string | null;
    /** The identifier that was imported (e.g. `Button`). */
    importedName: string;
    /** The raw specifier (for diagnostics). */
    specifier: string;
    location: SourceLoc;
}

// ---------------------------------------------------------------------------
// Extractor aggregate result (returned by extractFe)
// ---------------------------------------------------------------------------

export interface FeExtractResult {
    components: FeComponent[];
    hooks: FeHook[];
    routes: FeRoute[];
    /** Pages are internally derived from routes; kept for validator cross-check. */
    pages: FePage[];
    /** JSX render links (component → component via JSX use). */
    renders: FeRender[];
    /** Import links (file → file, filtered to .tsx/.jsx component imports). */
    imports: FeImportRef[];
}
