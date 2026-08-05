# Glimmer Signature Representation Revision -- Design

**Date:** 2026-08-05
**Supersedes:** the "Shared write path" bullet points under "## The Two Fixers" in
[`docs/superpowers/specs/2026-08-03-glimmer-signature-inference-design.md`](2026-08-03-glimmer-signature-inference-design.md)
(2026-08-03). Everything else in that spec -- architecture overview, shared Glimmer-transform
infrastructure, the two fixers' own inference algorithms, error handling, and the rest of the
testing approach -- is unchanged and still governs.
**Trigger:** a PR review comment on PR #1 (`tg-optro/type-stat`) requesting the Signature
always be a named `interface <ComponentName>Signature`, because that named form is needed
both for `class <ComponentName> extends Component<<ComponentName>Signature>` and for
`constructor(owner: Owner, args: <ComponentName>Signature['Args'])` in future work.

**Explicitly out of scope (unchanged from the original spec, restated for clarity):** `Args`
inference itself, and generating a typed constructor from a Signature's `Args` member, are
both still future work -- neither is designed here. This revision only changes how an
existing or newly-created Signature is _represented_; it does not add any new inference
capability. `test/cases/fixes/glimmerArgsSignature/constructorArgs` is a skipped fixture
tracking that future work, pre-encoding the aspirational target
(`constructor(owner: Owner, args: GreeterSignature['Args'])`) so it can be un-skipped once
that's designed and implemented.

## What's changing

The original spec's rule was: "if a Signature already exists (inline object-type literal, or
already a named interface/type alias): patch that existing member in place, in whatever form
the user already chose -- never convert an existing inline literal to a named interface or
vice versa." That last clause is reversed. The new rule: **every Signature, existing or new,
ends up as a named `interface <ComponentName>Signature`.**

| Existing shape                                             | Action                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (`extends Component`)                                 | Unchanged -- already generates a new named interface (original spec's behavior).                                                                                                                                                                                                                                                       |
| `interface <ComponentName>Signature`                       | Unchanged -- patch the member in place (original spec's behavior).                                                                                                                                                                                                                                                                     |
| `interface SomeOtherName`                                  | **New:** rename the declaration _and every same-file reference_ to `<ComponentName>Signature`, then patch the member -- unconditionally, even if some of those references are unrelated to being this component's Signature. See "Resolved: shared/multi-use interfaces" below.                                                        |
| `type SomeName = { ... }` (object-literal alias, any name) | **New:** convert `type` -> `interface`, renaming to `<ComponentName>Signature` if the name differs, then patch. Emit a warning (`output.stdout`) noting the conversion -- this changes the declaration's kind, which a user may not expect even though it's behavior-preserving.                                                       |
| Inline literal in the `extends` clause                     | **New:** extract it into a new `interface <ComponentName>Signature { ... }` declaration immediately above the class (same insertion point as the "no existing Signature" case), preserving its existing members, point the `extends` clause at the new name, then patch. Emit the same warning.                                        |
| Anything else (union, intersection, mapped type, etc.)     | **Changed:** `throw new Error(...)` (-> `MutationsComplaint`), same treatment as the naming-collision and `.gjs`-assumption cases below. Previously a silent no-op; per review feedback, anything this fixer can't resolve into the named-interface shape should say so loudly rather than silently leave the Signature un-normalized. |

## Renaming mechanism

Reuse the existing reference-finding utility, `findRelevantNodeReferencesAsNodes`
(`src/shared/references.ts`), the same one `FileInfoCache` already uses to gather
usage-evidence nodes for other fixers. It wraps
`ts.LanguageService.findReferences`, which is already available on
`request.services.languageService`; no new infrastructure is needed.

- **Scope: same-file references only.** No cross-file rewriting. Signature types aren't
  meant to be exported (an Ember/Glint convention -- they're a private implementation detail
  of the component module), so there's nothing to follow across file boundaries in the
  common case. Do not add cross-file traversal; this deliberately matches every other
  fixer in TypeStat, which only ever mutates one file at a time within a single pass.
- The rename touches the declaration's name and every in-file identifier reference to it
  (as found by `findReferences`) -- both the `extends Component<X>` type-argument reference
  and any other reference to `X` elsewhere in the file (e.g. a helper function typed to
  accept it).

### Resolved: shared/multi-use interfaces

**Decision: rename unconditionally, regardless of other uses.** The rename table row above
touches `SomeOtherName`'s declaration and every same-file reference `findReferences` finds,
even if some of those references have nothing to do with being this component's Signature
(e.g. `SomeOtherName` also used as some unrelated function's parameter type in the same
file). This is the simplest option and matches "always converge on the named-interface
convention" as asked for in review -- no detection of "is this interface used for anything
else" is needed, and this case does not route through the naming-collision guard (that guard
is only for when the _target_ name `<ComponentName>Signature` is already taken by something
else, not for when the _source_ name has other uses).

Separately, and unaffected by the above: this only ever arises for a hand-written `.gts`
file where a human already gave the Signature type a different name -- it's not a case a
fresh `.gjs` -> `.gts` conversion would ever produce on its own (a freshly-converted file has
no existing Signature at all, so it goes through the unchanged "no existing Signature" path
instead).

## Naming collision handling

If the target name `<ComponentName>Signature` is already bound to an unrelated declaration
elsewhere at the top level of the file (not the Signature being renamed/converted), do not
mutate. Instead, `throw new Error(...)` with a message identifying the file and the
colliding name. No special-casing is needed to route this into TypeStat's existing error
path: `findFirstMutations` (`src/shared/runtime.ts`) already catches any exception a mutator
throws and wraps it into a `MutationsComplaint`, logged and surfaced the same way any other
mutator failure is. Never silently proceed, and never auto-rename with a numeric suffix
(e.g. `GreeterSignature2`) -- a collision means the fixer can't safely guess what the user
wants, so it should say so loudly rather than mutate around the problem.

## `.gjs` assumption guard

`.gjs` files are assumed to never have an existing Signature type argument -- writing
`extends Component<SomeType>` requires TypeScript-only generic syntax that has no reason to
exist in a plain-JavaScript `.gjs` file. In the default configuration this is moot anyway,
since `.gjs` files are always renamed to `.gts` (Plan 1's rename subsystem) before any fixer
sees them. But `files.renameExtensions: false` lets a `.gjs` file reach the fixers unrenamed,
and because `.gjs`/`.gts` share the same `ScriptKind.Deferred` -> `ScriptKind.TS` parser
fallback, a `.gjs` file that (against convention) already contains TS-only Signature syntax
would still parse successfully -- the assumption is a semantic convention, not something the
parser enforces.

If a `.gjs` file is found to have an existing Signature type argument anyway, treat it the
same as a naming collision: `throw new Error(...)`, surfaced as a `MutationsComplaint`,
rather than silently normalizing it (which would still work mechanically, but would compound
an already-broken file rather than surface it).

## Warning on structural conversion

Converting a `type` alias to an `interface`, or extracting an inline literal into a new
top-level interface, is behavior-preserving but changes the declaration's kind/location --
visible enough that a user should be told it happened, even though it's not an error. Emit
a message via `request.options.output.stdout(...)` (the same channel
`createCoreMutationsProvider` already uses for wave-progress messages; there's no separate
"warning" channel in `ProcessOutput` today, and this doesn't need a new one) identifying the
file and what was converted. This is strictly informational -- it does not block or alter
the mutation, unlike the `throw`-based guards above.

## Impact on existing fixtures

**Required, not optional, as part of implementing this revision:**
`test/cases/fixes/glimmerBlocksSignature/multipleValues/` already exercises the "existing
inline literal" path today, and its `expected.gts` must be updated to match the new
behavior -- this is not a hypothetical future case, it's an existing, currently-passing
fixture that this change breaks by design. The implementation plan must include updating it
as an explicit task, not leave it to be discovered as a test failure.

```ts
export default class UnorderedList extends Component<{
	Args: UnorderedListArgs;
}> {}
```

Its current `expected.gts` shows the old behavior -- the `Blocks` member patched directly
into the inline literal, still untyped-by-name. Once this revision is implemented, that
fixture's expected output changes: the inline literal gets extracted into a new
`interface UnorderedListSignature { Args: UnorderedListArgs; Blocks: {...}; }`, and the
`extends` clause becomes `Component<UnorderedListSignature>`.

No other existing Glimmer fixture (`simpleDiv`, `ariaAttrs`, `namedBlocks`, the four
`glimmerComponents` smoke tests) has an existing Signature at all, so they're unaffected --
they all go through the unchanged "no existing Signature" path.

## Testing approach (additions to the original spec)

- **Unit tests** (`patchSignatureMember`'s existing hand-written-snippet suite) need new
  cases: renaming a differently-named interface (declaration + in-file reference rewritten),
  converting a type alias to an interface (same name, and a different name), extracting an
  inline literal into a new interface while preserving its other members, the naming
  collision throwing, and (a `.gjs`-specific case) the assumption-violation throwing.
- **Integration fixtures:** update `glimmerBlocksSignature/multipleValues` per the above.
  Add at least one new fixture exercising a renamed type alias or differently-named
  interface end-to-end through the real `rewriteModule` pipeline, not just the unit-level
  `patchSignatureMember` tests.
- Everything else in the original spec's testing approach (regression baseline for
  non-Glimmer files, real-checker integration tests, no mocking) is unchanged.
