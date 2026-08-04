# `.gjs`/`.gts` Migration -- Session Handoff

**Date:** 2026-08-03
**For:** the next agent picking this up
**Immediate next step:** run `superpowers:brainstorming`, scoped to subsystems 2/3 below, _before_ drafting Plan 2 (see "What Went Wrong (Process)" -- don't repeat it).

## Goal

Add full `.gjs`/`.gts` support to TypeStat: rename `.gjs` -> `.gts`, and infer/add full component `Signature` types (`Args`, `Blocks`, `Element`) plus continue TypeStat's existing type-inference fixers (`fixNoImplicitAny`, `fixIncompleteTypes`, `fixMissingProperties`, etc.) on ordinary class members and module-level bindings within `.gts`/`.gjs` files. "Globals" here means ordinary top-level TS bindings -- explicitly **not** Ember "loose mode" globally-resolved helpers/components (confirmed with the user; `.gts`/`.gjs` is the strict `ember-template-imports` format, where loose-mode resolution doesn't apply).

## Key Documents (read these first, in this order)

1. **`docs/dev/2026-08-03-glimmer-plugin-discovery.md`** -- the full discovery/research doc. Contains: TypeStat's entry points and pipeline architecture, why `.gjs`/`.gts` doesn't fit existing plugin points, the `pnpm patch` framing, the "must pass type check -> iteration not one-shot" constraint, and a **Spike Results** section with real, verified output from actually running `@glint/ember-tsc`'s `rewriteModule` and the real `ember-tsc` CLI against a test component. Read this in full -- it's long, but every claim in it has been corrected at least once during research, so don't skim past the "Update"/"Corrected"-flagged passages.
2. **`docs/superpowers/plans/2026-08-03-gjs-to-gts-rename-support.md`** -- Plan 1 (of 3), fully written per the `writing-plans` skill format, ready to execute. Covers only the rename subsystem (`.gjs` -> `.gts`), independent of everything else. **Not yet executed** -- the user was asked Subagent-Driven vs. Inline execution and the conversation moved to this handoff before they answered. Ask them, or just pick one and go, if picking this back up.

   **Keep this plan -- do not discard or redo it because brainstorming was skipped.** Its core decision (`.gjs` always maps to `.gts`, ignoring `renameExtensions`'s forced `"ts"`/`"tsx"` values) doesn't depend on anything the Plan 2/3 brainstorming session could change -- a template-carrying file can't become plain `.ts`/`.tsx` regardless of how Signature inference or fixer-retrofitting ends up designed. Brainstorming's value is proportional to ambiguity, and this plan has almost none. The one thing worth a quick sanity check (not a redo) once 2/3 are brainstormed: whether _sequencing_ changes -- e.g. a decision to hold off renaming until Signature inference exists, to avoid landing a pile of `.gts` files with no `Blocks`/`Element` and currently-failing type checks. That would change _when_ Plan 1 runs, not _what_ it does.

## What's Done

- Full architectural discovery of TypeStat's pipeline (entry points, provider chain, mutator/mutation layers, plugin points) -- see discovery doc's "Entry Points" section.
- Established `.gjs`/`.gts` can't be supported via TypeStat's one documented plugin point (custom mutators) or via any config seam on `createFileRenamesProvider` -- both are hardcoded, not pluggable.
- Established the user's team is already planning to `pnpm patch` the installed TypeStat package, which reframes "unsupported deep-import" concerns into "the actual plan" -- see discovery doc's "Is `createFileRenamesProvider` Itself Pluggable?" section.
- Established the "must pass type check" requirement means any Signature-inference mutator has to be a round-loop participant (`builtInFileMutators` entry, re-running its transform every round), not a one-shot script -- see discovery doc's "Constraint" section. TypeStat's existing round loop only guarantees convergence to "no more mutations found," not "verified zero diagnostics" -- that's a stronger bar than any existing built-in fixer promises today, worth deciding explicitly whether to close generally or accept as scoped to this feature.
- **Ran a real spike** (not just reading `.d.ts` files): installed `typescript`, `@glint/ember-tsc`, `@glimmer/component`, `ember-source` in a scratch dir; called `rewriteModule` on a test `.gts` component exercising all three Signature members. Verified:
  - `@glint/ember-tsc/transform`'s `rewriteModule` is a real, public, first-class export (confirmed via the live npm registry manifest, not just docs) -- takes your own `ts` instance (peer dep) plus a cheaply-constructed `GlintEnvironment` (`createDefaultConfig`).
  - `TransformedModule` (its return value) has genuinely bidirectional position mapping (`getOriginalOffset`/`getTransformedOffset`/`getOriginalRange`/`getTransformedRange`), not the one-directional/lossy mapping originally (wrongly) assumed.
  - `{{yield ...}}` desugars to a real, positioned call: `__glintDSL__.yieldToBlock(__glintRef__, "default")(item, index)` -- directly type-checkable.
  - Class members referenced _only_ inside the template become real, resolvable references in the transform (`this.filtered` -> `__glintRef__.this.filtered`) -- confirming template-only usage evidence is recoverable, but only by analyzing `transformedContents`, not the masked original.
  - `Element` inference is clean and exact: `emitElement("div").element` -> `HTMLDivElement`, no caveats.
  - `Blocks`/per-item generic inference (e.g. `{{#each ... as |item index|}}`'s `item` type) returned `any` in a bare, minimally-configured `ts.createProgram` -- traced this down, then disproved it as a real limitation by running the **actual `ember-tsc` CLI** against a properly configured project (real `tsconfig.json` with `"glint": {...}` block and `"types": ["ember-source/types"]`): it correctly resolved `[string, number]`. **Conclusion: build the transformed-content program from the target project's real `options.parsedTsConfig`** (which TypeStat's `src/services/language.ts` already loads for its normal pipeline) rather than a synthetic minimal one -- this is reuse of existing machinery, not new work.
  - Confirmed `ember-tsc` is not a separate tool from glint -- it's Glint v2's own CLI/core package (`@glint/ember-tsc`), built on Volar.js.
- **Plan 1 written** (rename subsystem) -- see above.

## What's NOT Done

- **Plans 2 and 3 are not written.** Per the discovery doc's Recommendation:
  - **Plan 2** (proposed): shared Glimmer-transform infrastructure (wrapping `rewriteModule` + `TransformedModule` position-mapping as reusable TypeStat internals) + the first Glimmer-aware `builtInFileMutators` entry, doing `Element` inference only (the cleanly-verified piece, lowest risk).
  - **Plan 3** (proposed): `Args`/`Blocks` inference on top of Plan 2's infrastructure, plus the retrofit of existing built-in fixers (`fixNoImplicitAny` etc.) to route mutation positions through `TransformedModule.getOriginalOffset`/`getOriginalRange` so they can see template-only usage evidence and still write correct edits into the original `.gts` file.
- The round-loop integration design (how exactly a Signature-inference mutator registers as idempotent, diff-and-patch-only-on-change, re-running `rewriteModule` every round) is described conceptually in the discovery doc but not designed at the code level.
- No CI mechanism designed yet for detecting `pnpm patch` drift against TypeStat version upgrades (flagged as a risk, not solved).
- `@glint/ember-tsc/transform`'s long-term export stability/semver contract was never confirmed upstream (still an open risk noted in the discovery doc).
- Whether to sequence `Element` -> `Blocks` -> `Args` (cheapest/clearest first) or some other order hasn't been decided with the user -- this is exactly the kind of question a brainstorming pass should raise.

## What Went Wrong (Process) -- Don't Repeat This

When the user asked "do you have enough info to plan an update?", the prior agent (me, this session) went straight to invoking `superpowers:writing-plans` and produced Plan 1, **skipping `superpowers:brainstorming`**. Per this project's skill-priority rule, process skills come first: brainstorming (explore intent/requirements/design) before implementation-planning skills. The long exploratory conversation before that point _substantively_ covered a lot of what brainstorming would do, which is why Plan 1 (small, low-ambiguity) turned out fine anyway -- but Plans 2/3 are genuinely novel, larger, and higher-risk, and deserve the formal brainstorming pass this time: sequencing (`Element` vs `Blocks` vs `Args` first?), whether to retrofit _all_ existing fixers or just a subset, how much of the "must pass type check" bar to actually commit to, etc.

**Do this first, before writing Plan 2:** invoke `superpowers:brainstorming`, scoped to subsystems 2 and 3.

## Spike Reproduction (if you need to re-verify anything)

The actual spike files lived in an ephemeral per-session scratchpad directory and are very likely gone. To reproduce: create a scratch dir, `npm install typescript @glint/ember-tsc @glimmer/component ember-source`, then call `createDefaultConfig(ts, rootDir).environment` and `rewriteModule(ts, { script: { filename, contents } }, environment)` on a `.gts` sample with `Args`/`{{yield}}`/`<div ...attributes>`. For the real (non-bare-program) check, scaffold a mini project with a `tsconfig.json` containing `"glint": { "environment": "ember-template-imports" }` and `"types": ["ember-source/types"]`, and run `node node_modules/.bin/ember-tsc --noEmit`. Full sample code and the exact real output are already transcribed in the discovery doc's "Spike Results" section -- start there before re-running anything.
