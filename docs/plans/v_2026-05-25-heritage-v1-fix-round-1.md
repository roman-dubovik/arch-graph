# Fix Round 1: heritage v1 — Phase 5 review findings

Date: 2026-05-25
Branch: `feat/code-intel-heritage-v1`
Source: pr-review-toolkit 4-reviewer pass on the diff vs main (1593+ / 27- across 9 files).

Findings consolidated by team-lead via cross-reviewer dedup. **15 actionable items + 2 deferred (P2).** Every fix below must keep the existing 93 tests green and the new test additions (F15) must pass.

---

## P0 — bundle into ONE fix commit per file (no `git add -A`)

### F1. `collectPathAliases` reads in-memory FS only — production builds NEVER resolve aliases

**File:** `src/code-intel/extractor.ts` ~line 1311–1357 (`collectPathAliases`).

**Symptom:** In `commands.ts` the Project is seeded only with `**/*.ts` / `**/*.tsx`. `tsconfig*.json` files are never added. The function iterates `project.getSourceFiles()` looking for tsconfigs — finds none → returns empty map. All path-alias imports (any `@workspace/<lib>` tsconfig `paths` entry) fall through to the FQN-substring fallback and silently bind to the wrong class. Tests pass only because `inMemoryProject` adds tsconfig source files explicitly.

**Fix shape:**
1. Replace the body of `collectPathAliases` so that it discovers tsconfig files via `node:fs` starting from `root` (look for `tsconfig.json`, `tsconfig.base.json` in `root` and one level up — common monorepo layouts). Use `node:fs/promises`? No — keep sync since the extractor is sync. Use `fs.readFileSync` + `JSON.parse`. Handle the in-memory case too: ALSO scan `project.getSourceFiles()` for tsconfigs as today (fixture path), but additionally read from disk for production.
2. Resolve each `paths` entry's first target to an absolute path under the tsconfig's directory.
3. Remove the unused `root` parameter from the signature — or actually use it to anchor the on-disk scan. Use it.

**AC:** in production, a `commands.ts`-driven build on a monorepo with `tsconfig.base.json` declaring `"@workspace/shared": ["libs/shared/src/index.ts"]` must populate the aliases map and resolve subclass.extendsClass correctly. Add a test that mimics this by writing a minimal tsconfig + monorepo to a tmp dir and invoking `extractCodeIntel` directly (NOT via `inMemoryProject`). One test is enough.

### F2. `collectPathAliases` swallows `JSON.parse` errors silently

**File:** `src/code-intel/extractor.ts` ~line 1321–1324.

**Fix shape:** When `JSON.parse` throws, write to `process.stderr` AND push an entry into a warnings channel (passed in by the caller — extend `collectPathAliases` to take `warnings: Array<{file:string; error:string}>` and push there). Caller at line ~187 propagates into `skippedFiles`.

### F3. `path.includes(s.file)` substring match → wrong-file pick in monorepos

**Files:** `src/code-intel/extractor.ts` lines ~1502, 1517, 1528, 1640, 1681.

**Fix shape:** Replace every `<absolute>.includes(s.file)` with a separator-boundary check:

```ts
function fileMatches(absolutePath: string, relFile: string): boolean {
    return absolutePath === relFile
        || absolutePath.endsWith('/' + relFile)
        || absolutePath.endsWith(relFile);  // when relFile already starts with '/'
}
```

Use this helper at all five sites. Add a regression test: two classes named `FooBase` at `apps/area/src/base.ts` and `libs/shared/src/base.ts`. The `apps/area/src/foo.controller.ts` imports `../base/base.controller` (resolved to `apps/area/src/base.ts`). `extendsClass` must point at the *apps/area* `FooBase`, not the `libs/shared` one.

### F4. `resolveBaseClassSymbol` arbitrary fallback when ambiguous

**File:** `src/code-intel/extractor.ts` ~line 1524–1529.

**Fix shape:** When `allCandidates.length > 1` and no same-file match, RETURN UNDEFINED. Do not silently pick `allCandidates[0]`. Caller already handles undefined correctly (skips method pass at line 1674).

### F5. Rest-spread delegation misclassified as `augmented`

**File:** `src/code-intel/extractor.ts` ~line 1576–1588 (`classifyOverrideKind`).

**Fix shape:** Treat `super.X(...args)` as `delegation` when:
- The super-call has exactly one argument, AND
- That argument is a `SpreadElement` whose inner expression is an identifier, AND
- The method's parameters end with a rest param whose name matches the spread identifier.

```ts
// Check if the single super arg is `...identifier` matching a rest param.
const args = inner.getArguments();
const methodParams = method.getParameters();
const lastParam = methodParams.at(-1);
if (
    args.length === 1
    && Node.isSpreadElement(args[0])
    && Node.isIdentifier(args[0].getExpression())
    && lastParam?.isRestParameter()
    && lastParam.getName() === args[0].getExpression().getText()
) {
    return 'delegation';
}
```

Add a test for `super.run(...args)` where method signature is `run(...args: unknown[])` — must classify as `delegation`. Add a counter-test: `super.run(...args)` where method has parameters `(a: string, b: number)` (no rest param) — must classify as `augmented`.

### F6. super-call `via` field malformed `super.run(dto)(dto)`

**File:** `src/code-intel/extractor.ts` line ~666 (in `collectParamFlows`).

**Symptom:** When `call.kind === 'super-call'`, `call.expression` already contains the full text `super.run(dto)`. The line `via: \`${call.expression}(${call.args.join(', ')})\`` then appends args again → `super.run(dto)(dto)`.

**Fix shape:** Special-case super-call:

```ts
const viaText = call.kind === 'super-call'
    ? call.expression
    : `${call.expression}(${call.args.join(', ')})`;
```

Use `viaText` in the flow `via` field. Add a test (extractor-side) that runs the full pipeline on a delegation method with a `dto` param and asserts the resulting flow's `via` ends in a single `)`.

### F7. Fields not iterated for `inheritsFrom`

**File:** `src/code-intel/extractor.ts` ~line 1677–1736 (`extractHeritageForClass`).

**Fix shape:** Add a parallel loop over `cls.getProperties()`. For each property whose name appears in an ancestor class along the `extendsClass` chain (use `findAncestorMethod` but extend it to also find fields, OR write `findAncestorField`): set `inheritsFrom`. **Do NOT set `overrideKind`** on fields — the three-way classifier only applies to method bodies.

Update `findAncestorMethod` to optionally check `kind: 'field'` too — rename to `findAncestorMember` and pass a kind filter. Or split into two helpers. Whichever keeps the code readable.

Test: subclass redeclaring `protected name: string` from a base entity — assert `FooSubclass.name` symbol has `inheritsFrom === <base id>`.

---

## P1 — bundle in the same commit OR a follow-up commit

### F8. B7 substring match → phantom impacts on prefix-name methods

**File:** `src/code-intel/queries.ts` line ~540.

**Fix shape:** Replace `directImpact.detail.includes(baseMethod.fqn)` with a word-boundary check. Preferred: match if detail starts with `${fqn}(` or contains ` ${fqn}(` or ` ${fqn} ` or equals `${fqn}`. Test that `"FooBase.runner(dto)"` does NOT match for base `"FooBase.run"`, and `"FooBase.run(dto: X)"` DOES match.

### F9. super-call `id` vs `order` off-by-one + per-class vs per-method counter clash

**File:** `src/code-intel/extractor.ts` lines ~1719–1728.

**Symptom:** id uses `superCallOrder` (pre-increment), `order` uses `superCallOrder` (post-increment) — they disagree. Also, the counter is scoped per-class so two methods in the same class share the order space, AND `collectFunctionFacts` uses a per-method counter starting at 1 — collision.

**Fix shape:**
1. Scope `superCallOrder` to per-method (initialize INSIDE the `for (const method of cls.getMethods())` loop, at line ~1677).
2. Increment BEFORE constructing the id so both id and order use the post-increment value.

### F10. Heritage catch lacks `process.stderr.write`

**File:** `src/code-intel/extractor.ts` line ~196–201 (the per-class try/catch in `extractCodeIntel`).

**Fix shape:** Add `process.stderr.write(\`[code-intel] skipping heritage for ${sf.getFilePath()} (${name}): ${msg}\n\`);` consistent with the adjacent file-level catch at line 184.

### F11. Silent return on internal invariant violations (classSymbol/methodSymbol lookup fails)

**File:** `src/code-intel/extractor.ts` lines ~1640–1644 and ~1681–1685.

**Fix shape:** Before the `return;` / `continue;` add a `process.stderr.write` describing the file-path mismatch between extraction passes. This shouldn't normally happen — when it does, the developer sees a clear signal.

### F12. `getTypeDefinition` chain truncation invisible

**File:** `src/code-intel/queries.ts` ~line 277–303 (the inherited-members chain walk).

**Fix shape:** Track a local `chainTruncated = false` flag. Set to `true` when the loop exits because `symbolsById.get(currentClassId)` returns undefined (as opposed to the chain reaching its natural end with `extendsClass === undefined`). Include `chainTruncated: true` in the return object when set. Extend the return type accordingly.

### F13. `overrideKind ⇒ inheritsFrom` unenforced invariant

**File:** `src/code-intel/extractor.ts` (heritage pass).

**Fix shape:** After setting `methodSymbol.overrideKind = classifyOverrideKind(method)` (around line 1695), assert that if overrideKind is non-undefined then inheritsFrom must also be set. If not, omit overrideKind (set to undefined) and `process.stderr.write` a warning. This keeps the invariant: a symbol with `overrideKind` always also has `inheritsFrom`.

### F14. Dead code in `resolveBaseClassSymbol`

**File:** `src/code-intel/extractor.ts` lines ~1471–1480.

**Fix shape:** Remove `sameFileCandidates` and `byFilePath` assignments — they are never read. Cleanup as part of F3/F4 work.

### F15. Test gaps — bundle as one new test commit

Add the following test cases (any extension of the existing test files is fine; new file `extractor.heritage.regression.test.ts` is also fine):

- **Cycle guard:** project with `class A extends B {}` + `class B extends A {}` — `extractCodeIntel` must complete without hanging; `extendsClass` set on at least one.
- **Multi-level barrel re-export:** `index.ts` → `module/index.ts` (`export * from`) → `base.controller.ts`. Subclass imports the top-level barrel via path alias. Verify `extendsClass` resolves.
- **A4 path-alias method-level:** extend the existing path-alias test to also assert on `inheritsFrom` and `overrideKind` of a subclass method.
- **A7 diagnostic emission:** extend the existing A7 test to also assert that `index.manifest.warnings?.skippedFiles` contains an entry for the broken class.
- **F8 prefix-match counter-example:** unit test on `impactContract` that ensures `FooBase.runner` impacts do not contaminate a query for `FooBase.run` delegation.

---

## Deferred (NOT in scope of this round)

- **`extendsTypeArgs` has no v1 consumer.** Per design doc §B6 it is reserved for the future generic-substitution work in `explainDataFlow`. Annotate the field's JSDoc with `// Reserved for B6 generic substitution; no v1 query consumes this yet.` and leave it alone. — F17 in the dedup table.
- **`as unknown as { ... }` casts in heritage tests.** Cosmetic — the return types are already declared correctly. Cleanup in a follow-up PR. — F16 in the dedup table.

---

## Quality gates after the fix round

- `npx vitest run src/code-intel/ src/mcp/` — ≥ 93 pass + new tests added in F15 (target ≥ 100).
- `npx tsc --noEmit -p tsconfig.typecheck.json` — TypeScript: No errors found.
- Optional: a real-filesystem smoke test for F1 (write a tmp tsconfig + project tree, call `extractCodeIntel` directly, assert path-alias resolution works).

## Commit policy

- ONE commit per F-group where possible (extractor fixes / queries fixes / tests). Selective `git add <path>`. NO Co-Authored-By, NO `git add -A`, NO `--no-verify`.
- If a commit covers multiple Fs, prefix the commit body with a bullet list of F-ids.
