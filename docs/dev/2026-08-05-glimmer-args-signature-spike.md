# Glimmer `Args` Signature Inference -- Spike

Follow-up to the original design spec's deferral (`docs/superpowers/specs/2026-08-03-glimmer-signature-inference-design.md`,
"Explicitly out of scope: `Args` inference"). `Element`/`Blocks` had a verified algorithm
before being designed; `Args` never did. This is that spike, using `@glint/ember-tsc@1.8.14`
(the real, installed dependency) against `rewriteModule` directly -- every claim below is
from real compiled output, not documentation or assumption.

**Bottom line: `Args` inference is buildable, but only for a narrower slice than
`Element`/`Blocks` covered, and it has one sharp correctness pitfall (a `never` contextual
type that looks like a signal but is actively wrong). Recommend building the narrow
"passed to an already-typed sink" case first, explicitly skipping everything else, rather
than attempting general inference.**

## 1. What `{{@argName}}` desugars to

Real `rewriteModule` output for `<p>Hello {{@name}}</p>`:

```
static { (...).templateForBackingValue(this, function(__glintRef__, __glintDSL__: ...) {
{
const __glintY__ = __glintDSL__.emitElement("p");
__glintDSL__.emitContent(__glintDSL__.resolveOrReturn(__glintRef__.args.name)());
}
__glintRef__; __glintDSL__;
}) }
```

`{{@name}}` becomes `__glintRef__.args.name` -- a plain `PropertyAccessExpression` chain,
not a call expression like `applySplattributes(...)`/`yieldToBlock(...)`. This is actually
**more** greppable than Element/Blocks: match any `PropertyAccessExpression` whose
`.expression` is itself a `PropertyAccessExpression` on `__glintRef__.args`. No
disambiguation-among-multiple-calls problem like Element's `emitElement` had.

Confirmed for direct interpolation, `{{if @active ...}}`, `{{#if @active}}`, repeated
usage of the same arg, and passing to a child component's own arg
(`<Child @value={{@count}} />` desugars to
`emitComponent(resolve(Child)({ value: __glintRef__.args.count, ...NamedArgsMarker }))`).

## 2. Detection: exactly the same 2339 pattern `fixMissingProperties` already uses

With **no** existing Signature, `Component`'s default type parameter is `unknown`, and
`Args<unknown>` resolves to `{}` -- so `__glintRef__.args.anything` is a **real compile
error**, every time:

```
error TS2339: Property 'name' does not exist on type '{}'.
```

With an **existing** Signature that's missing one member, only the undeclared one errors --
confirmed directly:

```

export default class Greeter extends Component<{ Args: { name: string } }> {
<template><p>{{@name}} {{@extra}}</p></template>
}

```

produces exactly one diagnostic, `TS2339: Property 'extra' does not exist on type
'{ name: string; }'`, at `@extra` only -- `@name` is clean. So detecting "which args need a
Signature entry" is just the existing missing-property pattern, applied at
`__glintRef__.args.X` instead of `this.X`. No new detection primitive needed.

**Implementation note, not a blocker:** `fixMissingProperties` also gates on `2339`, for
`this.X = value` assignments. The two are distinguishable by AST shape
(`__glintRef__.args.X` vs `this.X` in assignment position), but worth flagging since a
future `fixGlimmerArgsSignature` and `fixMissingProperties` would both be reacting to the
same diagnostic code on the same file.

## 3. Getting a _type_, not just detecting the gap, is where it gets hard

Per `getCodeFixesAtPosition`, `2339` here has **zero real codefixes** -- verified directly,
same finding as `2345` on the Element gap (see
`docs/research/2026-08-04-type-errors-report.md` §8.3). Mechanism A is closed off exactly
the same way. So this has to be mechanism B (direct type-checker inference) -- the question
is what signal is actually available to a direct inference pass.

`__glintRef__.args.name`'s own `getTypeAtLocation` is always `any` (it's reading a property
that, per the diagnostic, doesn't exist -- TypeScript still gives back _a_ type for error
recovery, and that type is `any`, useless). The only usable signal is
`checker.getContextualType(node)` -- the same "what does the surrounding expression expect
here" mechanism `fixIncompleteTypes` already uses. Results, compiled directly:

| Usage shape                                                                                                | `getContextualType` result                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `<p>Hello {{@name}}</p>` (direct interpolation)                                                            | `any` -- `emitContent`'s parameter is broad/renderable, no narrowing                          |
| `{{if @active "Yes" "No"}}` / `{{#if @active}}`                                                            | `none` (`undefined`)                                                                          |
| `{{concat "Hello " @name}}`                                                                                | `any` (untyped global helper in this repro; real apps typically have typed helpers, untested) |
| `<Child @value={{@count}} />`, Child's Signature has `Args: { value: number }`                             | **`number`** -- real, usable signal                                                           |
| Same, but Child's Signature has `Args: { value: string }`, used twice                                      | **`string`** both times -- consistent, trivially unionable if it ever varied                  |
| Same, but Child has **no** Signature at all (`Component` with no type arg, so Child's `Args` is also `{}`) | **`never`**                                                                                   |

Only one shape produces a real, trustworthy type: **the arg is passed as another,
already-Signature-typed component's own arg.** Everything else (direct interpolation,
conditionals, helper arguments, arithmetic on `this.args.x` in a getter) gives either `any`
or `none` -- no different from having no Signature at all, so nothing to write.

## 4. The `never` pitfall -- a hard correctness trap, not just a missing signal

The `Component` (Child, untyped) case above didn't return "no signal" (`undefined`/`any`) --
it returned **`never`**, a real type that `typeToString` prints as `"never"`. TypeScript
falls back to `never` when it can't find a consistent contextual binding (here: Child's
`Args` type is `{}`, so the object-literal-typed call has no valid slot for `value` at all,
and TS's inference gives up with `never` rather than `unknown`/`any`).

**This is not a "skip, nothing to see" case -- it's a "confidently wrong" case.** A naive
implementation that writes whatever `getContextualType` returns would produce
`Args: { count: never }`, which is worse than not inferring anything: `never` is
unsatisfiable, so any real usage of that arg becomes a type error for the _caller_.
Any implementation **must** explicitly filter `never` (and treat `any`/`unknown` as "no
signal" too, matching Element/Blocks' existing "skip rather than write a useless `any`"
rule from the original spec's Error Handling section) before ever writing a type.

## 5. Cross-file ordering (does this fit TypeStat's per-file model?)

The one usable signal (§3's `<Child @value={{@count}} />` row) depends on **Child's own
Signature already being resolved** -- which may live in a different file, fixed in a
_different_ fixer's pass. This sounds like it breaks TypeStat's one-file-at-a-time mutation
model, but it doesn't, for the same reason `fixIncompleteTypes` already tolerates
cross-file usage evidence: the `ts.Program` spans every file in scope, so by the time a
later wave visits the parent file, if Child's file was already mutated and written to disk
in an earlier wave, the rebuilt language service (`fileNamesAndServicesCache.clear()` after
every full pass) sees Child's _new_ Signature immediately. This is the exact same
"converges via fixed-point round-loop semantics, not a single pass" property the original
spec already states applies to this whole feature -- no new mechanism needed, just possibly
more waves to converge than Element/Blocks typically need. If Child is never independently
resolved (third-party component, or Child's own Args also can't be inferred), the parent's
arg permanently gets no signal -- graceful degradation, not a crash or a bad write.

## 6. Recommendation

Buildable now, but narrower in scope than "infer every `@arg`'s type from any usage":

- **In scope for a first version:** an arg whose _only_ usable signal is being passed
  through to another component's already-typed `@arg={{...}}` position. Detect via the same
  `2339`-on-`__glintRef__.args.X` pattern as `fixMissingProperties`; extract type via
  `getContextualType` at each such passthrough site; union across multiple sites if they
  differ (same tuple-widening precedent `fixGlimmerBlocksSignature` already established);
  **explicitly reject `never`, `any`, and `unknown`** results as "no signal," same as
  skipping rather than writing a useless type.
- **Out of scope, no known algorithm:** anything whose only usage is direct interpolation,
  a conditional, a helper argument, or similar -- there is no type signal available for
  these at all today; this is not a "TypeStat didn't try hard enough" gap, it's that
  TypeScript's own contextual-typing mechanism has nothing to offer at these positions.
- **Open, untested:** typed Ember helpers (`{{concat}}`, `{{array}}`, etc. with real type
  signatures rather than the untyped stand-in used in this spike's repro) might narrow
  `getContextualType` usefully. Worth a follow-up spike before ruling it in or out --
  not attempted here.

This recommendation is scoped to what's tractable, not "no Args inference is possible" --
the passthrough case is real, verified, and mechanically identical in spirit to how
`fixIncompleteTypes` already widens types from distant call-site usage.
