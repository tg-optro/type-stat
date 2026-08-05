# Glimmer (`.gjs`/`.gts`) Plugin Discovery

Discovery notes from investigating whether TypeStat could support `.gjs` -> `.gts`
conversion (analogous to its existing `.jsx` -> `.tsx` support) via a custom plugin.

**Conclusion: not possible with the existing plugin points.** File renaming is not
an extensibility hook, and the TypeScript Language Service used throughout the
pipeline cannot parse Glimmer's embedded `<template>` syntax to begin with.

## Entry Points

- [`bin/typestat.mjs`](../../bin/typestat.mjs) -> [`src/cli/runCli.ts`](../../src/cli/runCli.ts) --
  Commander.js parses CLI args.
- [`src/index.ts`](../../src/index.ts) (`typeStat()`) -- loads config via
  `loadPendingOptions`, globs files per options object via
  [`src/collectFileNames.ts`](../../src/collectFileNames.ts), then calls
  `automutate`'s `runMutations` with a provider from `createTypeStatProvider`.
- [`src/runtime/createTypeStatProvider.ts`](../../src/runtime/createTypeStatProvider.ts) --
  chains the pipeline of sub-providers, in order:
  1. `createFileRenamesProvider` -- `.js`/`.jsx` -> `.ts`/`.tsx` renames
  2. `createInstallMissingTypesProvider` -- installs `@types/*` packages
  3. `createRequireRenameProvider` -- fixes `require()` calls after renames
  4. `createCoreMutationsProvider` -- runs the built-in fixers (see
     [`src/mutators/builtIn/index.ts`](../../src/mutators/builtIn/index.ts))
  5. `createCleanupsProvider` -- post-fix cleanup
  6. `createMarkFilesModifiedProvider` -- tracks changed files
  7. `createPostProcessingProvider` -- final pass
- [`src/services/language.ts`](../../src/services/language.ts)
  (`createLanguageServices`) -- builds the `ts.LanguageServiceHost` and
  `ts.Program` that every mutator operates against.
- [`docs/Custom Mutators.md`](../Custom%20Mutators.md) -- the only supported
  extensibility point: `-m`/`--mutators` paths, each exporting a `mutator`
  function that receives a `FileMutationsRequest` (with an already-parsed
  `ts.SourceFile`) and returns `Mutation[]`.

## Why `.gjs` -> `.gts` Doesn't Fit

1. **File renaming is hardcoded, not pluggable.**
   [`src/runtime/providers/createFileRenamesProvider/index.ts`](../../src/runtime/providers/createFileRenamesProvider/index.ts)
   matches candidate files with a fixed regex,
   `javaScriptExtensionMatcher = /\.(?:c|m)?jsx?/i` (line 81), and
   [`getNewFileName.ts`](../../src/runtime/providers/createFileRenamesProvider/getNewFileName.ts)
   only ever emits `.ts` or `.tsx`. There is no config field or extension-mapping
   table to extend -- `.gjs`/`.gts` simply never matches.

2. **Custom mutators operate one level too late.** A custom `mutator`
   (per `docs/Custom Mutators.md`) receives a `FileMutationsRequest` containing
   an _already-parsed_ `ts.SourceFile` and returns proposed edits. It cannot
   intervene in which files get renamed, or how they get parsed -- it only
   proposes mutations to a file the pipeline has already accepted and parsed
   as valid TS/JS.

3. **The TypeScript Language Service can't parse `.gjs`/`.gts` at all.**
   `src/services/language.ts:41-44` builds `getScriptSnapshot` by calling
   `ts.sys.readFile` directly, and the tracked file list comes from
   `options.parsedTsConfig.fileNames` (standard `ts.parseJsonConfigFileContent`
   resolution). Glimmer's embedded `<template>` syntax in `.gjs`/`.gts` is not
   valid JS/TS grammar, so `ts.createLanguageService` would error or mis-parse
   the file. There is no preprocessing/transform hook in this layer to strip or
   translate template blocks before handing content to TypeScript (contrast
   with `vue-tsc`/`svelte-check`, which patch their `LanguageServiceHost`
   specifically to do this).

## What It Would Take

- A file-renaming rule for `.gjs` -> `.gts` (requires patching/forking
  `createFileRenamesProvider`; not configurable today).
- A preprocessing step ahead of `createLanguageServices` that strips/transforms
  Glimmer template syntax into parseable TS before `ts.sys.readFile`/
  `getScriptSnapshot` sees it, plus a matching step to re-inject template
  syntax on output. **Update:** this does not need to be reimplemented from
  scratch -- `@glint/ember-tsc/transform` publicly exports `rewriteModule`,
  which does exactly this transform and hands back a bidirectional
  position-mapping object. See "Verified: `@glint/ember-tsc/transform`..."
  below; this corrects an earlier, wrong assumption in this document that no
  such reusable, importable piece existed.

## Is `createFileRenamesProvider` Itself Pluggable?

No -- there is no config/CLI seam for it, unlike mutators. The provider
pipeline in `src/runtime/createTypeStatProvider.ts:22-29` is a hardcoded
literal array with no options field, CLI flag, or override mechanism to swap,
disable, or reorder stages. `createProviderFromProviders.ts` just walks
whatever array it's handed; there's no notion of a user-supplied override for
a given stage.

The only way to replace it today is to bypass `typeStat()`/the CLI entirely
and drive TypeStat programmatically: `tsup.config.ts` compiles (unbundled)
every file under `src/**/*.ts` into `lib/`, and `package.json` has no
`"exports"` map restricting subpath imports, so nothing technically blocks
deep-importing internal paths like `typestat/lib/runtime/providers/...` and
assembling your own provider array with a custom renamer swapped in. This is
unsupported and undocumented, though: `src/index.ts` (the actual public API)
only exports `typeStat`, `ResultStatus`, and result types -- not any provider
internals -- so there's no semver guarantee on those paths.

**Update:** given we're already planning to `pnpm patch` TypeStat for this
project, the above stops being a workaround and becomes the actual plan --
patching `lib/runtime/createTypeStatProvider.js` (or the equivalent
provider file) directly to splice in a custom renamer/stage is exactly the
mechanism, not something to feel bad about depending on. The one real risk:
`pnpm patch` pins to a specific version's _compiled_ output, so any TypeStat
upgrade can silently no-op the patch (if the target code moved) or break
outright. Worth a CI check that re-applies the patch and fails loudly on
drift, rather than discovering it's stopped applying at runtime.

## Alternative: A Narrower "Yield Types Only" Approach

Full template type-checking (validating invocations, arg types, element
types) is what forces a glint-style virtual-code/position-mapping rebuild. If
the real goal is narrower -- templates themselves don't need type-checking,
but the values a component **yields** to its blocks (its `Signature`'s
`Blocks` member) should be typed -- the scope shrinks a lot, though it's still
new work, not a config tweak:

1. **Detector/renamer extension** -- easy. Extend
   `javaScriptExtensionMatcher` in `createFileRenamesProvider/index.ts` to
   also match `.gjs`, and teach `getNewFileName.ts` to emit `.gts`.
2. **Don't swap the language service -- mask around it.** Replace the
   `<template>...</template>` block with a position-preserving stub (e.g.
   `null;` padded with matching newlines) before the file reaches TypeStat's
   normal `ts.createLanguageService` parse. Everything outside the template
   (the class, getters, arg interfaces) then type-checks completely normally
   with zero changes to `src/services/language.ts`.
3. **A real Glimmer parser for the masked-out region.** Use `@glimmer/syntax`
   (not regex -- nested mustaches, `as |block params|`, named blocks, and
   comments make regex unreliable) to find `{{yield ...}}` statements in the
   raw template text, before masking.
4. **Ancestor-chain desugaring into a scope-correct TS shim.** Walk each
   `yield` node's ancestors back to the template root, collecting any
   block-param binders it passed through (`{{#each}}`, `{{#let}}`,
   component-invocation `as |...|`), and translate that chain into a small
   synthetic TS function bound with the real `this` type. Query a disposable
   secondary `ts.Program` for that function's inferred return type -- this
   reuses the _real_ type-checker for the parts of the file that already
   parse as valid TS (e.g. a getter's return type), without needing the
   template body itself to be valid TS.
5. **Locate and patch the Signature.** Find the class's
   `extends Component<...>` type argument (inline object type or named
   interface), and add/update its `Blocks` member with the inferred type --
   structurally the same "find declaration, patch/add member" shape as
   `fixMissingProperties`, reusing `Printers.type` from `language.ts` to print
   the result.

### Concrete example

Input:

```gts
// highlight.gts
import Component from '@glimmer/component';

interface HighlightArgs {
  items: string[];
}

export default class Highlight extends Component<{ Args: HighlightArgs }> {
  get filtered() {
    return this.args.items.filter(Boolean);
  }

  <template>
    <ul>
      {{#each this.filtered as |item index|}}
        <li>{{yield item index}}</li>
      {{/each}}
    </ul>
  </template>
}
```

Step 2/3 finds, in the raw template text:

```
BlockStatement "each"
  params: [PathExpression "this.filtered"]
  blockParams: ["item", "index"]
  body:
    ElementNode "li"
      MustacheStatement "yield"
        params: [PathExpression "item", PathExpression "index"]
```

Step 4 desugars the `each` ancestor into a shim, fed to a disposable
`ts.Program`:

```ts
function __typestatYieldShim_0__(this: Highlight) {
	const __each_0 = this.filtered; // from `{{#each this.filtered ...}}`
	type __Elem_0 = (typeof __each_0)[number]; // desugar `as |item index|`
	const item: __Elem_0 = null!;
	const index: number = 0; // `each`'s second block param is always the index
	return [item, index] as const; // from `{{yield item index}}`
}
```

The checker resolves this to `readonly [string, number]` -- entirely through
the real, unmodified type-checker, since `this.filtered`'s type flows from
`HighlightArgs.items: string[]` normally.

Step 5 output:

```gts
export default class Highlight extends Component<{
  Args: HighlightArgs;
  Blocks: {
    default: [string, number];
  };
}> {
  ...
```

### Remaining complexity even in the narrow scope

- Ancestor-chain desugaring needs a translator per Glimmer binding construct
  worth supporting (`each`, `let`, `each-in`, component block params);
  unsupported constructs just mean "skip this yield," which is an acceptable
  degrade-gracefully boundary.
- Multiple yields to the same block (different branches) need their inferred
  types unified/deduped before writing the Signature member.
- Named blocks (`{{yield to="inverse"}}`) map to sibling keys under `Blocks`
  rather than always `default`.

This is a bounded, novel mutator (a `fixGlimmerYieldSignatures`-style addition
plus a small Glimmer-ancestor desugarer) -- smaller than reimplementing
glint, but genuine new complexity, not a drop-in plugin.

## Why Not Just Reuse Glint's AST/Language Service?

Glint is built on `@volar/language-core`/`@volar/typescript` -- the same
"virtual code" framework `vue-tsc` and Astro's tooling use. Its model:
parse the file, produce a synthetic **virtual TS document** where template
regions are desugared into TS-equivalent constructs (component invocations
become generic function calls encoding `Args`/`Blocks`/`Element`,
`{{yield item index}}` becomes a call into a synthesized callback type), and
maintain a position-mapping table between the virtual document and the
original file -- all wrapped behind an LSP/tsserver-shaped surface
(diagnostics, hover, completions: position-in, structured-info-out).

That doesn't compose with how TypeStat's mutators work, for several reasons:

1. **Query API vs. raw-AST mutation authoring.** TypeStat mutators walk a
   real `ts.SourceFile`/`ts.Node` tree directly (`ts.forEachChild`,
   `tsquery`), pattern-match node _shapes_ a human actually wrote, and call
   `node.getStart()`/`getEnd()` to produce literal text-edit ranges for
   `automutate`. Glint's surface is request/response (position in, diagnostic
   or hover info out), not a traversable AST tied to real file offsets.
2. **The virtual AST's nodes aren't shaped like the source.** Glint's
   synthesized `emitComponent(resolve(...), ...)`-style calls exist to let
   the checker validate an invocation -- there's no "parameter missing a type
   annotation" node in there for a mutator like `fixNoImplicitAny` to
   recognize, because nothing at that position was written by a human in
   that shape.
3. **~~Position mapping is one-directional and lossy for authoring~~ --
   corrected below.** This claim conflated two different layers. It's true of
   `TransformedModule.toVolarMappings()` specifically -- that conversion does
   collapse to equal-length regions, because that's what Volar's mapping
   format requires. But that's a lossy _conversion for Volar's benefit_, not a
   property of Glint's own mapping model. `TransformedModule` itself exposes
   bidirectional, differently-sized-region mapping directly
   (`getOriginalOffset`, `getTransformedOffset`, `getOriginalRange`,
   `getTransformedRange`, plus per-span `glimmerAstMapping` for
   finer-than-span granularity) without going through Volar at all. See the
   verified section below.
4. **~~No importable "give me a `ts.Program`" entry point~~ -- this was
   wrong.** `@glint/ember-tsc`'s published `package.json` `exports` map
   includes a clean, first-class `./transform` subpath (not one of its
   `-private/*` exports) resolving to `rewriteModule`. It still doesn't hand
   you a ready-made `ts.Program` -- you construct your own from its output --
   but that's a materially smaller gap than "stand up a headless language
   server or fork internals." See the verified section below.
5. **Dependency weight.** This point mostly still stands, but is narrower
   than originally framed: depending on `@glint/ember-tsc/transform`
   specifically is much lighter than adopting glint's whole
   Volar/tsserver/editor-integration stack (`typescript` is only a _peer_
   dependency of that package, per its published manifest, so you supply your
   own `ts` instance rather than inheriting a pinned copy). It still pulls in
   Ember/Glimmer-specific packages (`@glimmer/syntax`, `content-tag`,
   `@glint/template`) transitively, and its `./transform` export isn't
   accompanied by an explicit stability/semver contract in anything reviewed
   here -- still a framework-specific dependency to track, just a smaller one
   than previously assumed.

**Revised conclusion:** the masking + hand-rolled per-yield shim approach
above is still viable and glint-independent, but it may no longer be the
best path. Reusing `rewriteModule` to transform the _whole_ file (not just
isolated yield expressions) and running a normal `ts.Program` against its
output would offload the hardest, most bespoke part of the plan --
correctly desugaring arbitrary Glimmer control-flow constructs
(`{{#each}}`, `{{#let}}`, block params, nested invocations) into
type-checkable TS -- to glint's own production transform, rather than
reimplementing a narrower version of it by hand. See the next section.

## Verified: `@glint/ember-tsc/transform` Is a Public, Reusable Transform API

Also verified while checking ember-tsc (see next section): **`ember-tsc` is
not a separate/different tool from glint -- it _is_ Glint v2's CLI and core**
(per glint's own docs: "ember-tsc is the v2 version of the glint CLI binary,"
"a rebuild of Glint v1 atop the Volar.js language tooling framework"). Its
published npm package is `@glint/ember-tsc`, which ships both the `ember-tsc`
and `glint-language-server` binaries. Confirmed via the live npm registry
manifest for `@glint/ember-tsc@1.9.1` and the corresponding `.d.ts` files
served from jsdelivr -- not just prose documentation.

**What's actually exported** (`package.json` `exports` map,
`@glint/ember-tsc@1.9.1`):

```json
"./transform": {
  "types": "./lib/transform/index.d.ts",
  "default": "./lib/transform/index.js"
}
```

This is a clean, first-class subpath -- distinct from the package's many
`./-private/*` exports, which are the ones actually marked as not-for-general-use
by convention. `./transform` re-exports:

```ts
export declare function rewriteModule(
	ts: TSLib,
	{ script }: { script: { filename: string; contents: string } },
	environment: GlintEnvironment,
	clientId?: string,
): TransformedModule | null;
```

`TransformedModule` (from `./lib/transform/template/transformed-module.d.ts`)
holds `transformedContents: string` (the desugared, type-checkable TS) plus
bidirectional mapping methods:

- `getOriginalOffset(transformedOffset)` / `getTransformedOffset(originalFileName, originalOffset)`
- `getOriginalRange(transformedStart, transformedEnd)` / `getTransformedRange(...)`
- `getExactTransformedRanges(...)` and per-span `CorrelatedSpan.glimmerAstMapping`
  for finer-than-span granularity

Its own doc comment: "It can be queried with an offset or range in either the
original or transformed source to determine the corresponding offset or
range in the other." That's bidirectional, and native to Glint's own model --
the lossy, equal-length-region constraint only appears in
`toVolarMappings()`, a separate method that exists specifically to satisfy
Volar's mapping format for editor/tsserver consumption.

**Getting the required `GlintEnvironment` is cheap, not a full project
config load.** `@glint/ember-tsc`'s `./config` (well, its exported `config`
module) provides `createDefaultConfig(ts, rootDir)`, documented as "Creates a
default GlintConfig with ember-template-imports environment for use when no
tsconfig.json or jsconfig.json exists" -- and `GlintConfig.environment` is
exactly the `GlintEnvironment` `rewriteModule` needs. So, at a sketch level:

```ts
import ts from "typescript";
import { createDefaultConfig } from "@glint/ember-tsc"; // confirmed: root export, per lib/index.d.ts
import { rewriteModule } from "@glint/ember-tsc/transform";

const environment = createDefaultConfig(ts, rootDir).environment;
const transformed = rewriteModule(
	ts,
	{ script: { filename, contents } },
	environment,
);
```

`typescript` is a **peer** dependency of `@glint/ember-tsc` (`>=5.6.0` per its
manifest), not a bundled pinned copy -- so this is callable with TypeStat's
own `ts` instance rather than inheriting a separately-versioned one.

**What this changes for the plan above:** the "Alternative: A Narrower
'Yield Types Only' Approach" section's steps 3 (write a `@glimmer/syntax`
parser to find yields) and 4 (hand-roll ancestor-chain desugaring into a
shim) could likely be replaced by: call `rewriteModule` on the whole file,
feed `transformedContents` into TypeStat's own `ts.createLanguageService`,
resolve whatever type the transform's synthesized representation of each
`{{yield ...}}` produces, then use `TransformedModule`'s mapping methods to
translate that back to a position in the _original_ `.gts` file for patching
the Signature. That offloads the hardest part -- correctly desugaring
arbitrary Glimmer control-flow constructs -- to glint's own production
transform instead of reimplementing a narrower version of it.

**Not yet verified when this section was first written; now closed by a
real spike (below):** how `{{yield ...}}` appears in `transformedContents`,
and whether inferred types actually come out precise or degrade to `any`.

**Still genuinely open:** no explicit stability/semver contract was found
documenting `./transform` as intended for external consumption (vs. being an
implementation detail that happens to be exported cleanly) -- worth asking
upstream or checking the glint repo's own CONTRIBUTING/architecture docs
before depending on it long-term.

## Spike Results: `rewriteModule` End-to-End, Verified Against Real Output

Ran an actual spike rather than continuing to reason from types alone:
installed `typescript`, `@glint/ember-tsc`, `@glimmer/component`, and
`ember-source` in a scratch directory, called `rewriteModule` on a
`highlight.gts` sample exercising all three Signature members (`Args` via a
declared interface, `Blocks` via `{{yield item index}}` inside
`{{#each this.filtered as |item index|}}`, and `Element` via
`<div ...attributes>`), and inspected both the raw transformed text and the
real type-checker's resolution of it.

**Confirmed: `{{yield ...}}` becomes a real, positioned, type-checkable
call.** The template desugars (inside a `static { ... }` block using
`templateForBackingValue`) to code including:

```ts
const __glintY__ = __glintDSL__.emitComponent(__glintDSL__.resolve(__glintDSL__.Globals.each)(__glintRef__.this.filtered));
const [item, index] = __glintY__.blockParams["default"];
...
__glintDSL__.yieldToBlock(__glintRef__, "default")(item, index);
```

`item`/`index` are real identifiers at real, mappable positions --
`yieldToBlock`'s arguments are exactly the tuple we need for `Blocks`.

**Confirmed: class members referenced only inside the template are real,
type-checkable references in the transformed output**, not lost. `this.filtered`
(the getter) becomes `__glintRef__.this.filtered` inside the desugared block,
correctly threaded through to the real class instance type (proven by the
"chain diagnosis" trace below). This validates the earlier concern that
prompted the "full support" scope: template-only usage evidence _is_
recoverable, but only by analyzing `transformedContents` -- exactly why
existing fixers would need to look at the transform, not just the masked
original, to catch it.

**Confirmed clean and precise: `Element` inference.** Querying the checker
directly:

```
__glintDSL__.emitElement("div") -> { ...; element: HTMLDivElement; ... }
__glintDSL__.emitElement("li")  -> { ...; element: HTMLLIElement; ... }
```

Tag name to concrete DOM element type, resolved exactly, no caveats.

**A real dead end, then a real resolution: `Blocks`/per-item generic
inference needs the project's actual type roots, not a bare `ts.Program`.**
First pass: built a minimal `ts.createProgram` directly over
`transformedContents` with stripped-down `compilerOptions`. Result: `index`
resolved correctly to `number`, but `item` resolved to `any`, and the program
reported real diagnostics (`Argument of type 'unknown' is not assignable to
parameter of type 'Element'`; `'[any, number]' is not assignable to
parameter of type 'never'` -- expected, since this sample's Signature
deliberately omits `Blocks`/`Element` so the inference has something to add).
Traced the `any` through `resolve()`'s overloads
(`@glint/ember-tsc/types/-private/dsl/index.d.ts`) to `Globals.each`'s type
(`EachKeyword`, an abstract-constructor-with-its-own-generic pattern) --
looked like a structural TS generic-inference gap at first.

It wasn't. Ran the **actual `ember-tsc` CLI** (not a hand-built program)
against a properly configured mini-project (real `tsconfig.json` with a
`"glint": { "environment": "ember-template-imports" }` block and
`"types": ["ember-source/types"]`) on the identical `.gts` file:

```
highlight.gts(13,10): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'Element'.
highlight.gts(15,33): error TS2345: Argument of type '"default"' is not assignable to parameter of type 'never'.
highlight.gts(15,33): error TS2345: Argument of type '[string, number]' is not assignable to parameter of type 'never'.
```

**`[string, number]`, not `any`.** The earlier `any` was an artifact of my
bare-bones `compilerOptions` missing the project's real type roots
(`ember-source/types` specifically), not a limitation of the approach or of
TypeScript's generic inference. This is good news for the plan: it means
TypeStat doesn't need to build a special-purpose `ts.Program` for this at
all -- it should reuse the **same** `options.parsedTsConfig` it already
loads from the target project's real `tsconfig.json` for its normal
pipeline (`src/services/language.ts`), applied to `transformedContents`
instead of stripped-down options. That's not new work; it's using
machinery TypeStat already has.

**Net effect:** the core mechanism is now verified end-to-end for all three
Signature members, with real output, not just types read off `.d.ts` files.
The one remaining implementation detail (confirmed, not a risk) is: build
the transformed-content program from the real project's parsed tsconfig, not
a synthetic minimal one.

## Constraint: The Result Has to Actually Pass Type Check -- Iteration, Not One-Shot

Everything sketched above (call `rewriteModule` or hand-roll a shim, infer a
type, patch the `Blocks` member, done) is a **one-shot** transform. That's
not what TypeStat actually is. Per `docs/Architecture.md` and
`createCoreMutationsProvider`, TypeStat never runs once: each round recreates
language services, applies whatever mutations the _current_ diagnostics
support, and if anything changed, it restarts and reloads services,
repeating until a full pass produces zero mutations. That loop exists
because fixing one thing changes what the checker reports next.

A single infer-and-patch pass has no way to notice "the `Blocks` type I just
wrote doesn't actually satisfy the checker" and correct itself. For example:
the first pass might infer `Blocks: { default: [string, number] }`, but a
downstream consumer of the component could start erroring once that member
appears (if it destructures the block params differently than expected), or
another built-in fixer (`fixNoImplicitAny`, say) might change the type of
`this.filtered` on the same round, invalidating the inference just written.
Getting an actual passing result requires reacting to that, which one-shot
inference can't do.

**Implication for the design:** the yield-mutator can't be a script that
runs once against a file -- it has to be a participant in the same round
loop everything else uses. Concretely: register it as one of
`builtInFileMutators` (or add it via the mutators list / the `pnpm patch`),
let `createCoreMutationsProvider`'s existing round/restart logic drive it,
and make each invocation idempotent -- recompute the inferred type fresh
each round, diff against whatever `Blocks` currently says, patch only on a
real difference, and let the loop naturally stop once nothing changes
anymore.

**Added cost this brings:** the round loop already reruns because "the
underlying TypeScript source files generally change between rounds." A
yield-mutator built on `rewriteModule` would need to re-run the transform
and rebuild its (disposable) secondary `ts.Program` **every round**, in step
with the outer loop -- not once up front -- since `this.filtered`'s type (or
any other expression a yield depends on) can itself change between rounds as
other built-in fixers edit the same file concurrently.

**Honesty check worth keeping in view:** TypeStat's existing round loop
converges to a _fixed point_ (no more mutations found), not to a _verified
clean type-check_. The project's own README says outright it "will likely
add syntax and type errors" and is "a starting point... before you manually
fix and verify." So "iterate until no more mutations" and "iterate until it
actually passes type check" are not the same guarantee today, for _any_ of
the existing built-in fixers -- not just this one. If "must pass type check"
is a hard requirement here, that's a stronger bar than TypeStat currently
promises anywhere else in the codebase, and worth deciding explicitly
whether that's a gap to close in general (e.g. a final verification round
that asserts zero diagnostics before declaring success) or one to accept as
a known limitation specific to this feature.

## Does Glint Infer the Signature (`Args`/`Blocks`/`Element`)?

No -- and this matters a lot for scoping the yield-typing feature above.
Glint consumes an author-written `Signature` (the `Args`/`Blocks`/`Element`
object passed to `Component<Signature>`, or the equivalent for
template-only components) as **ground truth**, then checks the template body
against it:

- Checks that invocations pass `Args` matching the declared shape.
- Checks that `{{yield ...}}` calls match the declared `Blocks` shape (block
  names, arg count/types per block).
- Uses the declared `Element` type to type-check things like
  `...attributes` spreading.

None of that is inference _from_ the template _into_ the Signature -- it's
verification of the template _against_ an already-existing Signature. Delete
the `Blocks` member and glint doesn't look at the `{{yield}}` calls and
backfill it; it just stops being able to type-check yields (or treats them
as untyped/`unknown`, depending on strictness settings).

So the "figure out what a component yields and write it into the Signature"
step -- the shim-synthesis + ancestor-desugaring machinery described in the
narrower approach above -- isn't something glint already does that could be
shortcut past. It's the missing piece, full stop: today, in a real
Ember/Glimmer codebase, a human hand-writes the `Blocks` member, then glint
checks the template against it. No existing tool (glint included) looks at
`{{yield item index}}` and generates that member automatically.

**Masking-step nuance:** rather than masking the `<template>` block with a
literal `/* ... */` comment, prefer a syntactically-valid no-op statement
(`null;`, or a string literal) padded with matching newlines. A raw block
comment can break if the template's own text happens to contain a `*/`
sequence.

**Update -- partially verified:** the underlying claim holds up against the
actual `rewriteModule` signature inspected above
(`rewriteModule(ts, { script }, environment, clientId?)`). It takes only raw
script/template text plus an environment config -- no `Signature` in, and
`TransformedModule`'s public shape (`transformedContents`, mapping methods)
has no notion of a "derived Signature" out either. That's consistent with
"Glint transforms syntax and lets the real type-checker validate it against
whatever Signature is already in scope" rather than "Glint derives a
Signature from template usage." This section's _behavioral_ claim (glint
checks against an existing Signature) was already independently supported by
its documentation and remains unrefuted by the source-level check; what's
still unverified is a live `.gts` project actually exercising this end to
end, which wasn't done here.

## Recommendation

**Scope, as confirmed:** a full `.gjs`->`.gts` migration with full `Signature`
support (`Args`, `Blocks`, `Element`) plus continued support for existing
TypeStat fixers on class members and module-level bindings ("globals" ==
ordinary top-level TS bindings, not Ember loose-mode global resolution).

Given the spike results above, this is buildable, and the recommended
architecture is:

1. **Rename:** patch `createFileRenamesProvider`/`getNewFileName` to also
   match/emit `.gjs`/`.gts` (small, low-risk, via the already-planned
   `pnpm patch`).
2. **Signature inference (`Args`/`Blocks`/`Element`):** build on
   `@glint/ember-tsc/transform`'s `rewriteModule` rather than hand-rolling a
   `@glimmer/syntax` ancestor-desugaring shim -- it's a verified public
   export, and the spike confirmed it produces real, positioned,
   type-checkable output for all three Signature members when checked with
   the project's _actual_ parsed tsconfig (not a synthetic minimal one).
   `Element` inference is direct and clean (`emitElement(tag).element`).
   `Blocks`/per-item inference works correctly once the transformed-content
   program is built from `options.parsedTsConfig` -- machinery TypeStat
   already has in `src/services/language.ts`, not new work.
3. **Existing fixers on class members/globals:** since pass-through (non-template)
   regions of `transformedContents` map 1:1 to the original file (confirmed
   by the spike's `correlatedSpans` -- identical start/length for the
   plain-TS prefix), pointing TypeStat's language services at
   `transformedContents` instead of the raw/masked file lets existing
   built-in fixers keep working unmodified for ordinary class members and
   module-level bindings, _and_ additionally see template-only usage
   evidence (confirmed: `this.filtered` becomes a real, resolvable
   `__glintRef__.this.filtered` reference in the transform) -- provided
   each fixer's mutation-position logic is routed through
   `TransformedModule`'s `getOriginalOffset`/`getOriginalRange` before
   constructing the final edit, since only the (rare) fixer whose target
   node falls inside a _transformed_ (non-identity) span needs that
   translation at all.
4. **Round-loop integration:** per the constraint above, the
   Signature-inference logic can't be a one-shot script -- it has to be a
   `builtInFileMutators` participant, re-running `rewriteModule` and its
   diff-and-patch check every round alongside the existing fixers, so the
   whole file (template-derived types included) can actually converge
   rather than just receive one plausible guess.

Given `pnpm patch` is already the plan for the rename piece, folding all of
this in via the same patch is consistent with the existing plan -- more
surface area, not a new category of risk.

**This is now a "yes, plan it" scope**, not a "not enough info yet" one --
see the next message for the actual plan.
