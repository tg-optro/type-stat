# Glimmer Signature Inference (`Element` + `Blocks`) -- Design

> **Partially superseded:** the "Shared write path" rule under "## The Two Fixers" below
> (never convert an existing inline literal/type alias to a named interface) is reversed by
> [`docs/superpowers/specs/2026-08-05-glimmer-signature-representation-revision-design.md`](2026-08-05-glimmer-signature-representation-revision-design.md).
> Everything else in this document still governs.

**Date:** 2026-08-03
**Scope:** subsystems 2 and 3 of the `.gjs`/`.gts` migration effort (see
`docs/agent/2026-08-03-gjs-to-gts-migration-handoff.md` and
`docs/dev/2026-08-03-glimmer-plugin-discovery.md` for prior discovery/spike
work). Subsystem 1 (the `.gjs` -> `.gts` rename) is a separate, independent
plan (`docs/superpowers/plans/2026-08-03-gjs-to-gts-rename-support.md`) and is
not touched by this design.

**Goal:** infer and write a `.gts` component's `Element` and `Blocks`
Signature members from real template usage (`...attributes` spreads and
`{{yield ...}}` calls), and let TypeStat's existing built-in fixers
(`fixNoImplicitAny`, `fixMissingProperties`, etc.) see template-only usage
evidence for free, with no per-fixer code changes.

**Explicitly out of scope (deferred):**

- **`Args` inference** -- unlike `Element`/`Blocks`, no algorithm for this was
  ever spiked or verified. It needs its own future brainstorming/spike pass
  once this design's shared infrastructure has shipped and proven out.
- **A general "verify zero diagnostics" pass.** This feature converges via
  the same fixed-point round-loop semantics as every other built-in fixer
  (stop when a full pass produces no more mutations) -- it does not add a
  stronger type-check guarantee than TypeStat already provides elsewhere.
- **CI patch-drift detection** for the downstream `pnpm patch` (flagged as an
  open risk in the discovery doc, not solved here).

## Distribution Context

This repo is the upstream TypeStat OSS project (`JoshuaKGoldberg/TypeStat`),
but the intended distribution mechanism for this feature is a downstream
`pnpm patch` -- not an upstream PR. Concretely: this feature is developed as
ordinary first-class source changes in this repo (same as any other fixer),
and the resulting diff is later captured as a patch applied against an
installed `typestat` copy in a separate downstream project. This does not
change _how_ the feature is built (still real `src/` changes, real tests,
real docs) -- it only changes how it ships. `@glint/ember-tsc` becomes a real
dependency of `typestat`'s own `package.json`, which `pnpm patch-commit`
captures along with the source diff, so the downstream install picks it up
as part of `typestat`'s dependency tree.

## Sequencing

Build order: **`Element` -> `Blocks` -> `Args`** (cheapest/clearest first,
per the spike's confirmed results). This design covers `Element` and
`Blocks` fully; `Args` is future work.

No cross-plan sequencing change is needed for Plan 1 (the rename plan):
`createTypeStatProvider`'s pipeline already runs `createFileRenamesProvider`
(stage 1) before `createCoreMutationsProvider` (stage 4, where these new
fixers live) within a single `typeStat()` invocation. A `.gjs` file is
already renamed to `.gts` before any fixer -- new or existing -- ever sees
it, by construction of the existing pipeline order.

## Architecture Overview

The core shift: TypeStat's `ts.Program` for `.gts`/`.gjs` files must be built
from Glint's **transformed content**
(`rewriteModule(...).transformedContents`), not raw file text and not a
masked stub. This is what lets the existing 7 built-in fixers see
template-only usage evidence (e.g. `this.filtered` desugaring to
`__glintRef__.this.filtered`) automatically, with zero changes to any
individual fixer -- they simply walk whatever AST the program hands them, as
they already do today. Ordinary `.ts`/`.tsx` files are completely unaffected
by any of this (no `rewriteModule` call, no behavior change).

Three pieces:

1. **Content substitution** (`src/services/language.ts`) -- for
   `.gts`/`.gjs` files only, `getScriptSnapshot`/`readFile` return
   `transformedContents` instead of raw text.
2. **Position remap** (new, wrapping `src/runtime/findMutationsInFile.ts`) --
   every `Mutation.range` produced by _any_ fixer running against a `.gts`
   file is passed through `TransformedModule.getOriginalOffset`/
   `getOriginalRange` before reaching `automutate`. Pass-through
   (non-template) regions map 1:1, so this is a no-op for the large majority
   of positions -- it only actually translates positions that fall inside
   Glimmer-desugared spans. In practice this matters much more as a
   correctness safety net for the _existing_ 7 fixers (which mostly only
   ever produce mutations targeting pass-through/identity-mapped nodes
   anyway, since desugared template constructs like
   `__glintDSL__.emitComponent(...)` don't match any existing fixer's node
   selectors) than as something the two new fixers below depend on for their
   own output.
3. **Two new fixers** -- `fixGlimmerElementSignature`,
   `fixGlimmerBlocksSignature` -- added to `builtInFileMutators` exactly like
   any other fixer, each gated by its own `options.fixes.<flag>`.

## Shared Glimmer-Transform Infrastructure

New module, `src/services/glimmer/index.ts` (alongside the existing `src/services/language.ts`):

```ts
declare function getGlimmerTransform(
	fileName: string,
	rawContents: string,
	options: TypeStatOptions,
): null | TransformedModule;
declare function isGlimmerFile(fileName: string): boolean; // /\.g(?:js|ts)$/i
```

- **`GlintEnvironment` construction:** `createDefaultConfig(ts, options.package.directory).environment`,
  constructed once and memoized for the lifetime of a `LanguageServices`
  build (cheap per the spike, but no reason to rebuild per file).
- **Per-file memoization:** keyed by file path only. Safe because
  `createLanguageServices` is only rebuilt after a full pass completes
  (`fileNamesAndServicesCache.clear()`), so "cached for one pass" is exactly
  the right lifetime -- it naturally expires when it should (the next pass
  re-reads raw content and re-transforms, picking up whatever any fixer
  changed in the previous pass). This also means `getScriptSnapshot` and
  `readFile` share one memoized result instead of double-invoking
  `rewriteModule` for the same file.
- **Threading the result to the remap step:** `LanguageServices` gains a new
  field, `readonly glimmerTransforms: ReadonlyMap<string, TransformedModule>`,
  populated as a side effect of the same memoized lookup `getScriptSnapshot`
  uses. The `findMutationsInFile` wrapper reads
  `request.services.glimmerTransforms.get(request.sourceFile.fileName)` to
  decide whether/how to remap -- `undefined` for ordinary files, meaning no
  remap work happens for the non-Glimmer case.
- **Content substitution in `language.ts`:**
  ```ts
  const contents = ts.sys.readFile(fileName) ?? "";
  return isGlimmerFile(fileName)
  	? ts.ScriptSnapshot.fromString(
  			getGlimmerTransform(fileName, contents, options)?.transformedContents ??
  				contents,
  		)
  	: ts.ScriptSnapshot.fromString(contents);
  ```
  (`readFile` gets the equivalent treatment so the host and program never
  disagree about a file's content.)

## The Two Fixers

**Shared write path:** both fixers call a common helper in the shared infra
module, `patchSignatureMember(sourceFile, componentClassNode, memberName, newTypeText)`.

- If the class has **no** existing Signature (`extends Component` with no
  type argument): generate a new `interface <ComponentName>Signature { ... }`
  declaration above the class, and change the `extends` clause to
  `extends Component<<ComponentName>Signature>`.
- If a Signature **already exists** (inline object-type literal, or already
  a named interface/type alias): patch that existing member in place,
  in whatever form the user already chose -- never convert an existing
  inline literal to a named interface or vice versa.

This mirrors `fixMissingProperties`'s existing "find declaration, patch/add
member" shape, reusing `Printers.type` (`language.ts`) to print the result.
**This write always targets a position in the pass-through (identity-mapped)
class-header region of the original file** -- neither fixer needs
`getOriginalOffset`/`getOriginalRange` for its own output; the central remap
described above is for the existing fixers' retrofit, not for these two.

### `fixGlimmerElementSignature`

1. Parse the raw (untransformed) template text with `@glimmer/syntax` to
   find the element node carrying `...attributes` (Glimmer allows at most
   one per template -- if none exists, skip the file, nothing to infer).
2. Use `TransformedModule.getTransformedOffset`/`getTransformedRange`
   (**forward** direction, original -> transformed) to find where that
   element's `emitElement(...)` call landed in `transformedContents`. This is
   the one piece of real remaining complexity: disambiguating _which_
   `emitElement` call is the attributes-receiving one when a template has
   multiple elements.
3. Ask the checker (built from `transformedContents` + the project's real
   `parsedTsConfig`, per the spike) for that call's `.element` property type
   -- e.g. `HTMLDivElement`.
4. `patchSignatureMember(..., "Element", "HTMLDivElement")`.

### `fixGlimmerBlocksSignature`

1. Walk the parsed `transformedContents` AST (a normal `ts.Node` tree -- no
   raw-text scanning) for
   `__glintDSL__.yieldToBlock(__glintRef__, "<blockName>")(...)` call
   expressions.
2. For each, ask the checker for the argument list's types -- a tuple, e.g.
   `[string, number]`.
3. Group by block name; if a block is yielded to more than once (different
   branches), union the tuples member-wise before writing.
4. `patchSignatureMember(..., "Blocks", "{ [blockName]: [...], ... }")` for
   the full discovered set.

Both fixers are registered in `builtInFileMutators` exactly like existing
fixers, gated by their own `options.fixes.fixGlimmerElementSignature`/
`fixGlimmerBlocksSignature` flags, and follow standard round-loop
convergence: recompute fresh each round, diff against the current Signature
text, patch only on real change, stop once nothing changes.

## Error Handling

- **`rewriteModule` returns `null`** (unparseable template): fall back to
  raw content in `getScriptSnapshot`/`readFile` -- same as TypeStat's
  existing behavior for any malformed input; no special-cased crash.
- **`rewriteModule` throws** (unexpected internal glint error): caught at the
  `getGlimmerTransform` call site, logged via `request.options.output.stderr`
  (matching the existing `tryGetMutation`/`findFirstMutations` catch-and-log
  idiom), treated as "no transform available" -> same raw-content fallback.
  One file's transform failure never aborts the run.
- **Nothing to infer** (no `...attributes`, no `{{yield}}`): not an error --
  no mutation produced for that fixer this round, identical to how every
  other fixer behaves when its pattern doesn't match.
- **Checker resolves `any`/`unknown`** at an `emitElement`/`yieldToBlock`
  call site (e.g. missing `ember-source/types` in the project's tsconfig,
  reproducing the spike's initial dead end): skip writing that member rather
  than writing a useless `Element: any` -- degrade gracefully rather than
  pollute the Signature with a non-answer.

## Testing Approach

- **Unit tests** (no real Ember/glint runtime): `patchSignatureMember`'s
  three behaviors (create named interface from scratch; patch existing
  inline literal in place; patch existing named interface in place) against
  hand-written source snippets -- no `rewriteModule` involved, since this
  logic only touches the class-header/Signature text.
- **Integration tests** (real `@glint/ember-tsc`, mirroring the spike): a
  fixture set (e.g. `src/mutators/builtIn/fixGlimmerElementSignature/__fixtures__/`)
  of real `.gts` samples (the `highlight.gts`-style example from the
  discovery doc) run through the actual `rewriteModule` plus a real
  `ts.Program` built from a minimal but real `tsconfig.json`
  (`"glint": { "environment": "ember-template-imports" }`,
  `"types": ["ember-source/types"]`), asserting the exact inferred
  `Element`/`Blocks` text gets written. Mocking the checker would test
  nothing meaningful, since the entire point of this feature is real type
  inference through a real checker.
- **New dependencies:** `@glint/ember-tsc` becomes a real (non-dev)
  dependency (imported at runtime by the shared infra module).
  `@glimmer/component` and `ember-source` are devDependencies, used only to
  run integration tests and resolve `ember-source/types` in fixture
  tsconfigs.
- **Regression baseline:** existing fixer test suites run unchanged against
  `.ts`/`.tsx` fixtures -- content substitution only triggers for
  `.gjs`/`.gts` files, so there's no behavior-change risk to verify for the
  existing 7 fixers on non-Glimmer files.

## Open Risks Carried Forward

- `@glint/ember-tsc/transform`'s long-term export stability/semver contract
  was never confirmed upstream (noted in the discovery doc; still open).
- `pnpm patch` drift against future TypeStat version upgrades has no CI
  detection mechanism yet (noted in the discovery doc; still open, not
  solved by this design).
