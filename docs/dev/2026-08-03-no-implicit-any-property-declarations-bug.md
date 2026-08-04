# Bug: `fixNoImplicitAny` never fixes class property declarations

**Date found:** 2026-08-03
**Status:** Confirmed, not yet fixed
**Scope:** Core TypeStat (`src/mutations/codeFixes/noImplicitAny.ts`) -- unrelated to the
`.gjs`/`.gts` Glimmer work in progress on this branch. Found incidentally while
investigating why a `@tracked count;` property in a Glimmer test fixture never got an
inferred `: number` annotation added, no matter what assignment/usage evidence was present
in the surrounding class.

## Summary

`fixNoImplicitAnyPropertyDeclarations` (the sub-fixer responsible for adding type
annotations to untyped class properties under `fixes.noImplicitAny`) never produces a
mutation for **any** class property, regardless of how much assignment evidence exists
elsewhere in the class. It has almost certainly been a no-op since it was written.

## Root cause

`src/mutations/codeFixes/noImplicitAny.ts:23-24`:

```ts
enum NoImplicitAnyErrorCode {
	PropertyOrVariable = 7005,
	Parameter = 7006,
}
```

`getNoImplicitAnyMutations` (same file, ~line 55-56) uses `NoImplicitAnyErrorCode.PropertyOrVariable`
(**7005**) for both property declarations and plain variable declarations:

```ts
const codeFixes = getCodeFixIfMatchedByDiagnostic(request, node, [
	ts.isParameter(node)
		? NoImplicitAnyErrorCode.Parameter
		: NoImplicitAnyErrorCode.PropertyOrVariable,
]);
```

But TypeScript emits **two different diagnostic codes** for these cases, per its own
`diagnosticMessages.json` (verified directly against the installed `typescript@5.9.3`
package, not assumed):

- `Variable_0_implicitly_has_an_1_type` = **7005** -- `let`/`var`/`const` declarations only.
- `Member_0_implicitly_has_an_1_type` = **7008** -- class property/member declarations.

`getCodeFixIfMatchedByDiagnostic` (`src/mutations/codeFixes/getCodeFixIfMatchedByDiagnostic.ts`)
does a strict `errorCodes.includes(diagnostic.code)` check against the node's real emitted
diagnostics before ever calling `getCodeFixesAtPosition`:

```ts
if (
	!semanticDiagnostics.some(
		(diagnostic) =>
			errorCodes.includes(diagnostic.code) &&
			...
	)
) {
	return undefined;
}
```

Since a class property emits **7008**, not **7005**, this check always fails for property
declarations, so the sub-fixer always returns `undefined` -- independent of assignment
evidence, decorators, constructors, or anything else about the surrounding class.

Plain variable declarations are unaffected by this bug, though for a narrower reason than
originally stated here: a same-scope `let x; x = 0;` no longer emits 7005 at all under
`typescript@5.9.3`'s control-flow analysis (verified directly -- it compiles clean under
`--strict --noImplicitAny`), so there's nothing there for either the bug or the fixer to
act on either way. 7005 does still fire for declarations TypeScript can't narrow across a
module/ambient boundary, e.g. `export let value; value = 0;`, and a real "infer from usage"
fix exists for that case, so `fixNoImplicitAnyVariableDeclarations` (which shares the same
enum value) is verified correct for that narrower footprint. Only the property-declaration
path is broken. See `docs/research/2026-08-04-type-errors-report.md` for the fuller
diagnostic-code audit this correction came from.

## Verification

Confirmed directly against the repo's own installed TypeScript compiler (not assumed from
documentation), by compiling a minimal repro with `--noImplicitAny --strict`:

```ts
class WithDecorator {
	@noop count;

	go() {
		this.count = 0;
		this.count++;
	}
}
```

Real `tsc` output:

```
a.ts(4,8): error TS7008: Member 'count' implicitly has an 'any' type.
```

Confirmed **7008**, not 7005, is what TypeScript actually emits for a class property --
matching `typescript.js`'s own diagnostic message table:

```
Variable_0_implicitly_has_an_1_type: diag(7005, ...)
Member_0_implicitly_has_an_1_type: diag(7008, ...)
```

Also confirmed the decorator itself isn't a factor -- an undecorated `count;` property
with identical usage emits the exact same 7008 diagnostic.

## Existing test coverage doesn't catch this

`test/fixNoImplicitAny.test.ts`'s `"property declarations"` case points at
`test/cases/fixes/noImplicitAny/propertyDeclarations`, but that fixture's `typestat.json`
only enables `fixes.incompleteTypes`, not `fixes.noImplicitAny` -- despite living under a
`noImplicitAny/` directory. Every property in that fixture's `original.ts` already has an
explicit type annotation (it's testing type _widening_ via `fixIncompleteTypes`, not
implicit-any recovery). There is no existing fixture anywhere in the suite that exercises
`fixNoImplicitAnyPropertyDeclarations` actually adding a type to a previously-untyped class
property.

## Impact

Any TypeStat user relying on `fixes.noImplicitAny` to add types to untyped class
properties (a documented use case per `fixNoImplicitAny/README.md`) gets silent no-ops for
every property declaration. Parameters and variable declarations are unaffected.

## Skipped regression test

`test/glimmerComponents.test.ts` has a test, `"infers a @tracked property's type from usage
evidence"`, currently marked `it.skip` with a comment pointing back to this file. Its
fixture (`test/cases/fixes/glimmerComponents/tracked/`) already has `expected.gts` set to
the correct target output (`@tracked count: number`), so once this bug is fixed, that test
can simply be un-skipped -- no further fixture changes should be needed.

`test/class.test.ts` has an analogous plain-`.ts` (non-Glimmer) test, `"infers an instance
field's type from usage evidence"`, also `it.skip`, confirming this bug isn't
Glimmer-specific. Its fixture (`test/cases/fixes/class/instanceField/`) likewise already has
`expected.ts` set to the correct target (`count: number`).

## Suggested fix

Split the enum into the correct, distinct codes and select by node kind rather than
lumping properties in with variables:

```ts
enum NoImplicitAnyErrorCode {
	Parameter = 7006,
	Property = 7008,
	Variable = 7005,
}
```

```ts
const codeFixes = getCodeFixIfMatchedByDiagnostic(request, node, [
	ts.isParameter(node)
		? NoImplicitAnyErrorCode.Parameter
		: ts.isPropertyDeclaration(node)
			? NoImplicitAnyErrorCode.Property
			: NoImplicitAnyErrorCode.Variable,
]);
```

A real regression fixture (untyped class property + genuine assignment evidence,
`fixes.noImplicitAny` enabled, asserting the type actually gets added) should accompany
the fix, since none currently exists.

## How this was found

While building Glimmer smoke-test fixtures for the `.gjs`/`.gts` Signature-inference work,
we tried to make a `@tracked count;` property's type "ambiguous enough" for `fixNoImplicitAny`
to recover it from usage (`this.count++`, `this.count = 0` in various methods). It never
worked under any variation tried (constructor assignment, non-constructor assignment,
increment-only usage, with and without the `@tracked` decorator). Reading
`fixNoImplicitAnyPropertyDeclarations`'s actual source rather than continuing to guess at
black-box behavior revealed the wrong-error-code bug directly.
