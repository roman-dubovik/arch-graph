# arch-graph code-intel self-eval results

Date: 2026-05-22

Sidecar built with:

```bash
npm run dev -- code-intel build --config ./arch-graph.config.ts --out <tmp>
```

Build result: `3284 symbols`, `6785 calls`.

## Results

| ID | Capability | Status | Key proof packet |
|----|------------|--------|------------------|
| CI1 | symbol | PASS | `runBuild` resolved first to `src/pipeline/build.ts:118`, signature returns `Promise<BuildResult>`. |
| CI2 | call-graph | PASS | `runBuild -> discoverOwnership`, then later `runBuild -> extractNats`, `runBuild -> enumerateHandlers`; nested calls include `discoverServices`, `discoverLibs`, `scanFiles`. |
| CI3 | data-flow | PASS | `cfg` flows into `discoverOwnership(cfg)`, `extractNats(cfg, project)`, `enumerateHandlers(cfg)`, `enumerateSenders(cfg)`, and path-building calls. |
| CI4 | control-flow | PASS | `semanticSearch` branch at `src/semantic/search.ts:353`: `minScore !== undefined && s.score < minScore`, `thenText: return false;`. |
| CI5 | symbol | PASS | `makeSemanticSearchHandler` resolved to `src/mcp/server.ts:735`, param `handlerOpts: SemanticSearchHandlerOpts`. |
| CI6 | control-flow | PASS | `makeGraphLoader` branch at `src/mcp/server.ts:230`: `st.mtimeMs === failedMtime`, nested under `!handle || st.mtimeMs !== handle.mtimeMs`; branch body explains cached-handle fallback. |
| CI7 | data-flow | PASS | `runCodeIntelCommand(args)` flows into `explainDataFlow(index, { target: requireString(args.target), param: requireString(args.param) })`. |
| CI8 | impact | PASS | `SemanticManifest` subject resolved to `src/semantic/types.ts:150`; type references include `src/semantic/io.ts`, `src/semantic/builder.ts`, `src/semantic/search.ts`, and tests. |
| CI9 | symbol | PASS | `SearchResponse` resolved to `src/semantic/search.ts:113`; fields: `output`, `exitCode`, `stderrWarning`. |
| CI10 | control-flow | PASS | `mapTypeOrmToGraph` branch at `src/mapper/typeorm-to-graph.ts:168`: `rel.decorator === 'ManyToMany' && rel.joinTableName && !tableNodes.has(...)`; body writes `tableNodes.set(...)`. |

## Adjustments Made During Eval

- `resolve_symbol` now ranks exact functions/methods above fields/params, so `runBuild` resolves to the pipeline function before `WizardAnswers.runBuild`.
- `explain_branch` accepts repo-relative file paths, not only absolute paths from the sidecar.
- Branch facts include compact `thenText`, which lets control-flow answers show what the branch does without opening the file.
- `impact_contract` returns the resolved `subject` symbol and sorts contract-level references before field-level noise.

