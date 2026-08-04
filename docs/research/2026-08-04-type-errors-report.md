# TypeScript Error Codes and TypeStat's Fixing Capability

**Date:** 2026-08-04
**Scope:** How TypeStat and the TypeScript language service actually work together at
runtime, and — against that mechanism — which TypeScript diagnostic codes TypeStat catches
and correctly fixes, which it attempts but is silently broken for, and which no current
TypeStat mechanism could ever fix.

**Method:** Every claim below was checked against a real `typescript@5.9.3` compile or a
real TypeStat run (the same package version and one AST checkout as the repo). Nothing here
is inferred from documentation or the TypeScript source's comments alone — see the
scratch-repro paths cited under each table for where to reproduce a claim yourself.

## 1. Executive summary

- TypeStat's fixers use **two structurally different mechanisms**, not one:
  1. **Diagnostic-code delegation** — ask the language service "does this exact node have
     diagnostic code N", and if so, take TypeScript's own suggested text edit verbatim.
     This is the mechanism most of TypeStat's documentation describes, but it's used by only
     **3 of TypeStat's 9 built-in fixer families** (`noImplicitAny`, `noImplicitThis`,
     `missingProperties`).
  2. **Direct type-checker inference** — compare a declared type against the type(s)
     TypeStat's own analysis of usage/expressions observes, with no reference to any
     TypeScript diagnostic code at all. This is what `fixIncompleteTypes`,
     `fixNoInferableTypes`, `fixStrictNonNullAssertions`, and the two Glimmer Signature
     fixers actually do. `fixImportExtensions` is a third, even simpler case: pure
     string/filesystem manipulation, no type information consulted at all.
- Across the entire codebase, only **4 numeric TypeScript diagnostic codes** are ever
  hardcoded: `7005`, `7006`, `2683`, `2339`. Everything else TypeStat fixes, it fixes without
  ever checking a diagnostic code.
- Of those 4 codes, **3 are correctly wired** (`7006`, `2683`, `2339`) and **1 is misapplied**
  (`7005` is requested for class property declarations, which actually emit `7008` — a
  confirmed, pre-existing bug, documented separately in
  [`docs/dev/2026-08-03-no-implicit-any-property-declarations-bug.md`](../dev/2026-08-03-no-implicit-any-property-declarations-bug.md)).
- TypeScript defines **1,345 distinct `Error`-category diagnostic codes**. TypeStat's
  diagnostic-code mechanism only ever asks about 4 of them. The other ~1,341 aren't "ignored
  bugs" — they're simply never asked about, because TypeStat's fixer scope was never
  designed to cover them.
- `ts.getSupportedCodeFixes()` — the API that looks like it should answer "which codes can
  TypeScript auto-fix" — **cannot answer that question**. It returned all 1,345 codes
  verbatim in our test, including pure syntax errors like `1002` ("Unterminated string
  literal"). The only reliable way to know if TypeScript can fix a given diagnostic
  _instance_ is to ask `getCodeFixesAtPosition` for that exact instance — which is exactly
  what TypeStat does at runtime, and exactly why a static "fixable codes" table isn't fully
  possible to produce, only a set of verified spot checks.

## 2. How TypeStat and the TypeScript language service work together

### 2.1 One language service per "wave"

`createCoreMutationsProvider` (`src/runtime/providers/createCoreMutationsProvider.ts`) drives
the whole mutation loop. Each call:

1. Builds (or reuses, within a pass) a `ts.LanguageService` over every file in scope
   (`createLanguageServices`, `src/services/language.ts`).
2. Walks the file list, and for each file, calls `collectFilteredNodes` to find candidate
   AST nodes, then `findMutationsInFile` to run every _enabled_ fixer against those nodes.
3. Stops early once **100 mutations** or **10 seconds** have elapsed in the current wave (so
   one wave never runs unbounded on a huge codebase).
4. Once every file has been visited once, the language service is torn down and rebuilt from
   scratch for the next wave, so newly-applied mutations are visible to subsequent fixers.
5. Repeats until a wave that started from the beginning of the file list produces **zero**
   mutations — i.e. two effectively-empty passes in a row. A `WaveTracker` detects mutation
   loops that never converge and bails out with an error rather than spinning forever.

This is why TypeStat is described as working in "waves": it is a fixed-point iteration over
the file set, re-deriving fresh diagnostics/types after every batch of edits, not a single
pass.

### 2.2 Mechanism A — diagnostic-code delegation

Three fixer families never do their own inference. They ask TypeScript "is this exact
diagnostic present on this exact node", and if so, ask TypeScript for the fix and copy it
verbatim. The gate is `getCodeFixIfMatchedByDiagnostic`
(`src/mutations/codeFixes/getCodeFixIfMatchedByDiagnostic.ts`):

```ts
export const getCodeFixIfMatchedByDiagnostic = (
	request: FileMutationsRequest,
	node: ts.Node,
	errorCodes: number[],
) => {
	const semanticDiagnostics =
		request.services.languageService.getSemanticDiagnostics(
			request.sourceFile.fileName,
		);
	if (
		!semanticDiagnostics.some(
			(diagnostic) =>
				errorCodes.includes(diagnostic.code) &&
				diagnostic.start &&
				diagnostic.length &&
				diagnostic.start >= node.pos &&
				diagnostic.start + diagnostic.length <= node.end,
		)
	) {
		return undefined;
	}

	return request.services.languageService.getCodeFixesAtPosition(
		request.sourceFile.fileName,
		node.getStart(request.sourceFile),
		node.end,
		errorCodes,
		{ insertSpaceBeforeAndAfterBinaryOperators: true },
		{},
	);
};
```

The comment on this function explains why the pre-check exists: `getCodeFixesAtPosition`
itself does **not** verify that the diagnostic is actually being emitted for the requested
node — a caller has to check that first, or it'll happily hand back a fix for a diagnostic
that isn't really there. This double-check (does the diagnostic exist for this node _and_
does TypeScript then offer a codefix) is the entire "methodology" this report evaluates.

Consumers of this mechanism:

| Fixer                                  | File                                                                                  | Error code(s) requested                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `fixNoImplicitAnyParameters`           | `src/mutators/builtIn/fixNoImplicitAny/fixNoImplicitAnyParameters/index.ts`           | `7006` (via `src/mutations/codeFixes/noImplicitAny.ts`)      |
| `fixNoImplicitAnyVariableDeclarations` | `src/mutators/builtIn/fixNoImplicitAny/fixNoImplicitAnyVariableDeclarations/index.ts` | `7005` (same file)                                           |
| `fixNoImplicitAnyPropertyDeclarations` | `src/mutators/builtIn/fixNoImplicitAny/fixNoImplicitAnyPropertyDeclarations/index.ts` | `7005` (same file — **the bug**; see §4)                     |
| `fixNoImplicitThis`                    | `src/mutators/builtIn/fixNoImplicitThis/index.ts`                                     | `2683` (via `src/mutations/codeFixes/noImplicitThis.ts`)     |
| `fixMissingPropertyAccesses`           | `src/mutators/builtIn/fixMissingProperties/fixMissingPropertyAccesses/index.ts`       | `2339` (via `src/mutations/codeFixes/addMissingProperty.ts`) |

One architectural wrinkle: `addMissingProperty.ts`'s `getMissingPropertyCodeFixes` calls
`getCodeFixesAtPosition` directly, **skipping** the `getSemanticDiagnostics` pre-check the
other four fixers use. We verified this is harmless — TypeScript's own API returns `[]`
safely when the diagnostic isn't genuinely present — but it means this one fixer trusts
`getCodeFixesAtPosition`'s internal filtering rather than double-checking it, unlike its
siblings.

### 2.3 Mechanism B — direct type-checker inference (no diagnostic code involved)

The majority of TypeStat's fixers never call `getSemanticDiagnostics`,
`getSuggestionDiagnostics`, or `getCodeFixesAtPosition` at all. Confirmed by grep (zero hits
for any of those three APIs) and by reading each fixer's source:

- **`fixIncompleteTypes`** (return types, property-declaration widening, implicit/interface
  generics, React prop types) — computes the node's _declared_ type and the type(s) actually
  observed at usage sites via `getTypeAtLocationIfNotError`, and unions them if they differ.
  There is no TypeScript diagnostic corresponding to "your type annotation should be wider";
  a user who hand-fixed this without TypeStat would typically be reacting to a `2322`/`2345`
  assignability error at the call site, not at the declaration TypeStat edits.
- **`fixNoInferableTypes`** — pure structural comparison to strip a type annotation that
  TypeScript's own inference would produce anyway. This isn't a TypeScript compiler error at
  all (TypeScript is happy either way); it mirrors the ESLint `no-inferrable-types` rule's
  concern, not a diagnostic code.
- **`fixStrictNonNullAssertions`** — adds or removes `!` non-null assertions based on the
  type checker's own nullability analysis. The scenarios it prevents, if hand-written wrong,
  would show up as diagnostics like `2531`/`2532`/`2533` ("Object is possibly
  'null'/'undefined'") or `18047`/`18048`/`18049` in newer control-flow narrowing contexts —
  but the fixer itself never asks about any of those codes; it re-derives nullability from
  the type directly.
- **`fixImportExtensions`** — resolves module specifiers against the filesystem
  (`node:fs`'s `globSync`) and appends the correct extension. No type-checking or
  diagnostics of any kind. (The scenario it prevents is closest to `2834`/`2835` — "Relative
  import paths need explicit file extensions" — but again, not consulted directly.)
- **`fixGlimmerElementSignature` / `fixGlimmerBlocksSignature`** (this branch's new fixers)
  — match specific desugared AST shapes emitted by `@glint/ember-tsc`'s template transform
  (`applySplattributes(...)`, `yieldToBlock(...)` call expressions) and query the type
  checker for the argument types flowing through them. No error code is ever involved;
  there usually isn't even a TypeScript diagnostic on the original `.gjs`/`.gts` source for
  these cases at all — the "error" is more that a `Signature`'s `Element`/`Blocks` member is
  missing or wrong, which the type checker won't complain about at the class-declaration
  level.

`fixEnumAsArgument` is not a separate fixer — `test/fixEnumAsArgument.test.ts` exercises a
scenario that's actually handled under `fixIncompleteTypes`.

### 2.4 A third layer, specific to `.gjs`/`.gts`

For Glimmer files only, everything above sits on top of an additional transform-and-remap
layer (`src/services/glimmer/index.ts`, `src/runtime/remapGlimmerMutations.ts`) that runs
`@glint/ember-tsc`'s `rewriteModule` first and maps diagnostics/mutations back to the
original template-containing source. This doesn't change which diagnostic codes exist or
which fixers use them — it only changes _where in the file_ a diagnostic or fix ends up
being anchored. It's out of scope for this report's classification, but worth naming since
it's the reason `.gjs`/`.gts` files can participate in either mechanism above at all.

## 3. Why "TypeScript error codes" isn't a complete lens on TypeStat

Reflexively, "which error codes does TypeStat handle" undersells what most of TypeStat does
(§2.3's fixers solve real problems with no corresponding diagnostic code) and oversells what
the diagnostic-code mechanism could ever cover on its own (only 4 codes are wired up, out of
1,345 that exist). The rest of this report still enumerates codes, because that's what was
asked for and it's the sharpest lens for the minority of fixers that do use codes — but
treat §5's family tables as "what's theoretically in-scope for mechanism A if someone wired
it up," not "what TypeStat currently does."

### 3.1 `getSupportedCodeFixes()` is not a usable oracle

Before auditing individual codes, we checked whether TypeScript exposes a cheap way to know
"can any codefix ever apply to code N" without compiling a real repro. `ts.getSupportedCodeFixes()`
looked promising — it returns an array of diagnostic-code strings. In `typescript@5.9.3`, it
returned **all 1,345 `Error`-category codes**, plus some non-`Error` ones, **1,362 codes in
total** — including pure syntax errors like `1002` ("Unterminated string literal") and
`1005` ("'{0}' expected"), which obviously have no meaningful auto-fix. This API reports
which codes _some_ registered `CodeFixProvider` module declares interest in, not which codes
can actually produce a fix for a given diagnostic instance.

The only reliable signal is what TypeStat itself does at runtime: call
`getCodeFixesAtPosition` for the _specific_ diagnostic instance and see what comes back.
Two direct comparisons make the point:

- **Code `7008`** ("Member '{0}' implicitly has an '{1}' type", the class-property case):
  against a real repro (`class C { count; f() { this.count = 0; } }`),
  `getCodeFixesAtPosition` returns **one real fix**: `"Infer type of 'count' from usage"`.
  Genuinely fixable.
- **Code `7023`** ("'{0}' implicitly has return type 'any' because ... referenced ... in one
  of its return expressions", the self-referential-getter case from
  `test/cases/fixes/class/instanceGetter/`): against that exact fixture,
  `getCodeFixesAtPosition` returns **`[]`**. Not fixable by any current mechanism, regardless
  of what TypeStat's own code does — there is nothing for it to relay.

Both codes are "supported" per `getSupportedCodeFixes()`. Only one is actually fixable.
That's the whole problem with treating that API as ground truth.

## 4. The 4 codes TypeStat's diagnostic-code mechanism actually uses

All rows independently compiled with `tsc@5.9.3 --strict --noImplicitAny`, not assumed from
source comments.

| Code                | Canonical message                             | Fixer                                  | Targeted node / precondition                                                                                                                           | Status                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `7006`              | Parameter '{0}' implicitly has an '{1}' type. | `fixNoImplicitAnyParameters`           | `ts.ParameterDeclaration`, no type, no initializer (checked on the first parameter only — TypeScript reports all of a parameter list's fixes together) | **Correct**                                                        | `function f(value) { return value * 2; } f(1);` → `TS7006` on `value`; real "infer from usage" fix → `value: number`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `7005`              | Variable '{0}' implicitly has an '{1}' type.  | `fixNoImplicitAnyVariableDeclarations` | `ts.VariableDeclaration`, no type/initializer, not a binding pattern, not `for`-`in`/`of`                                                              | **Correct, but much narrower in practice than its own docs imply** | Plain `let x; x = 0;` — even across closures — does **not** emit `7005` under modern TypeScript control-flow analysis; the type is inferred silently, no diagnostic, nothing broken but nothing to fix either. `7005` only fires today for declarations TypeScript can't narrow across a module/ambient boundary: `export let value; value = 0;` or `declare let value: /* nothing */;`. A real "infer from usage" fix does exist for those narrower cases.                                                                                                                                                                                                |
| `7005` (misapplied) | —                                             | `fixNoImplicitAnyPropertyDeclarations` | `ts.PropertyDeclaration`, no type/initializer — reuses the _same_ `7005` constant as the variable case above                                           | **Bug** (previously found and documented)                          | Class properties emit **`7008`**, never `7005`, under every scenario tried (with/without decorators, with/without constructor assignment). `getCodeFixIfMatchedByDiagnostic` only ever checks for `7005`, so the check always fails and this sub-fixer has almost certainly never fired since it was written. Full writeup: [`docs/dev/2026-08-03-no-implicit-any-property-declarations-bug.md`](../dev/2026-08-03-no-implicit-any-property-declarations-bug.md); regression fixtures already pre-encode the correct target and are `it.skip`ped pending the fix (`test/cases/fixes/glimmerComponents/tracked/`, `test/cases/fixes/class/instanceField/`). |
| `2683`              | 'this' implicitly has type 'any'.             | `fixNoImplicitThis`                    | `ts.ThisExpression` inside a function with no inferable `this` context                                                                                 | **Correct**                                                        | The fixer's own README example compiles to `TS2683` at exactly the flagged `this`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `2339`              | Property '{0}' does not exist on type '{1}'.  | `fixMissingPropertyAccesses`           | `this.x = value` where `x` isn't a declared property of the enclosing class                                                                            | **Correct**                                                        | The README's own `constructor() { this.happy = true; this.name = ""; }` on an otherwise-empty class produces two `TS2339`s at exactly those positions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Correction to prior documentation:** the earlier bug report's justification for "plain
variable declarations are unaffected by this bug" used the example `let x; x = 0;` and
stated it "really does emit 7005." That specific example does not reproduce in
`typescript@5.9.3` — see the `7005` row above. The report's underlying conclusion (the
property-declaration sub-fixer is broken, the variable sub-fixer is not) is still correct;
only the illustrative example was wrong, and has been corrected there to match this finding.

## 5. Everything else: mechanism-B fixers, mapped to the diagnostics they conceptually replace

These fixers never check a diagnostic code, so there's no "is code N wired correctly"
question to ask. What follows is informational: the TypeScript diagnostic a developer would
see if they wrote the "before" state by hand and tried to compile it, for orientation only.

| Fixer                                                      | Mechanism                                                                                                              | Nearest conceptual TypeScript diagnostic(s)                                                                                                                     | Notes                                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixIncompleteTypes` (all sub-fixers)                      | Compares declared type vs. observed usage types via the type checker directly                                          | `2322` (Type is not assignable), `2345` (Argument type not assignable) at the _usage_ site, not the declaration TypeStat edits                                  | No code is checked at the node being fixed; TypeScript may not even be erroring anywhere for the file TypeStat edits, since the "incompleteness" may only bite at a not-yet-written call site. |
| `fixNoInferableTypes` (all sub-fixers)                     | Structural redundancy check against TypeScript's own would-be inference                                                | _(none — not a compiler error)_                                                                                                                                 | Equivalent to the ESLint `no-inferrable-types` rule's concern, not a `tsc` diagnostic.                                                                                                         |
| `fixStrictNonNullAssertions` (all sub-fixers)              | Type checker nullability analysis                                                                                      | `2531`/`2532`/`2533` ("Object is possibly 'null'/'undefined'/either"), `2721`–`2723` (same, for invocation), `18047`–`18049` (newer narrowing-context variants) | Fixer re-derives nullability itself; never queries these codes.                                                                                                                                |
| `fixImportExtensions`                                      | Filesystem specifier resolution (`node:fs` `globSync`), no type info                                                   | `2834`/`2835` ("Relative import paths need explicit file extensions..."), `2876` (unsafe rewrite)                                                               | Purely mechanical; doesn't run the type checker at all.                                                                                                                                        |
| `fixGlimmerElementSignature` / `fixGlimmerBlocksSignature` | Matches Glint's desugared `applySplattributes`/`yieldToBlock` call shapes, queries the type checker for argument types | _(usually none)_                                                                                                                                                | The gap these fixers close (a missing/wrong `Signature` member) typically isn't a TypeScript diagnostic on the source at all.                                                                  |

## 6. Deep dive: the `--noImplicitAny` family (codes 7000–7099)

This is the family most relevant to TypeStat's stated purpose, so it gets full treatment
rather than a summary. 47 codes in `typescript@5.9.3` fall in the `7000`–`7099` range or have
message text matching "implicitly has [an] ... any". `registered` reflects
`getSupportedCodeFixes()` (per §3.1, not a reliable fixability signal on its own —
included for completeness only). `verified` reflects an actual `getCodeFixesAtPosition` call
against a real repro; everything not marked was not independently tested for this report (a
full empirical sweep of all 1,345 codes was out of scope — see §7).

| Code | Message                                                                                                                                                                | Registered¹ | Empirically verified                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2602 | JSX element implicitly has type 'any' because the global type 'JSX.Element' does not exist.                                                                            | yes         | not tested                                                                                                                                                                 |
| 2683 | 'this' implicitly has type 'any' because it does not have a type annotation.                                                                                           | yes         | **yes — real fix, and TypeStat correctly uses this one (`fixNoImplicitThis`)**                                                                                             |
| 7005 | Variable '{0}' implicitly has an '{1}' type.                                                                                                                           | yes         | **yes — real fix; TypeStat correctly uses this for variables, misapplies it to properties (§4)**                                                                           |
| 7006 | Parameter '{0}' implicitly has an '{1}' type.                                                                                                                          | yes         | **yes — real fix, and TypeStat correctly uses this one (`fixNoImplicitAnyParameters`)**                                                                                    |
| 7008 | Member '{0}' implicitly has an '{1}' type.                                                                                                                             | yes         | **yes — real fix ("Infer type of 'x' from usage"); TypeStat never asks for this code, due to the §4 bug**                                                                  |
| 7009 | 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.                                                                              | yes         | not tested                                                                                                                                                                 |
| 7010 | '{0}', which lacks return-type annotation, implicitly has an '{1}' return type.                                                                                        | yes         | not tested                                                                                                                                                                 |
| 7011 | Function expression, which lacks return-type annotation, implicitly has an '{0}' return type.                                                                          | yes         | not tested                                                                                                                                                                 |
| 7012 | This overload implicitly returns the type '{0}' because it lacks a return type annotation.                                                                             | yes         | not tested                                                                                                                                                                 |
| 7013 | Construct signature, which lacks return-type annotation, implicitly has an 'any' return type.                                                                          | yes         | not tested                                                                                                                                                                 |
| 7014 | Function type, which lacks return-type annotation, implicitly has an '{0}' return type.                                                                                | yes         | not tested                                                                                                                                                                 |
| 7015 | Element implicitly has an 'any' type because index expression is not of type 'number'.                                                                                 | yes         | not tested                                                                                                                                                                 |
| 7016 | Could not find a declaration file for module '{0}'. '{1}' implicitly has an 'any' type.                                                                                | yes         | not tested                                                                                                                                                                 |
| 7017 | Element implicitly has an 'any' type because type '{0}' has no index signature.                                                                                        | yes         | not tested                                                                                                                                                                 |
| 7018 | Object literal's property '{0}' implicitly has an '{1}' type.                                                                                                          | yes         | not tested                                                                                                                                                                 |
| 7019 | Rest parameter '{0}' implicitly has an 'any[]' type.                                                                                                                   | yes         | not tested                                                                                                                                                                 |
| 7020 | Call signature, which lacks return-type annotation, implicitly has an 'any' return type.                                                                               | yes         | not tested                                                                                                                                                                 |
| 7022 | '{0}' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer.                            | yes         | not tested                                                                                                                                                                 |
| 7023 | '{0}' implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.    | yes         | **no — `getCodeFixesAtPosition` returns `[]` on a real, realistic repro (`test/cases/fixes/class/instanceGetter/`); see [`test/class.test.ts`](../../test/class.test.ts)** |
| 7024 | Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions. | yes         | not tested                                                                                                                                                                 |
| 7025 | Generator implicitly has yield type '{0}'. Consider supplying a return type annotation.                                                                                | yes         | not tested                                                                                                                                                                 |
| 7026 | JSX element implicitly has type 'any' because no interface 'JSX.{0}' exists.                                                                                           | yes         | not tested                                                                                                                                                                 |
| 7027 | Unreachable code detected.                                                                                                                                             | yes         | not tested                                                                                                                                                                 |
| 7028 | Unused label.                                                                                                                                                          | yes         | not tested                                                                                                                                                                 |
| 7029 | Fallthrough case in switch.                                                                                                                                            | yes         | not tested                                                                                                                                                                 |
| 7030 | Not all code paths return a value.                                                                                                                                     | yes         | not tested                                                                                                                                                                 |
| 7031 | Binding element '{0}' implicitly has an '{1}' type.                                                                                                                    | yes         | not tested                                                                                                                                                                 |
| 7032 | Property '{0}' implicitly has type 'any', because its set accessor lacks a parameter type annotation.                                                                  | yes         | not tested                                                                                                                                                                 |
| 7033 | Property '{0}' implicitly has type 'any', because its get accessor lacks a return type annotation.                                                                     | yes         | not tested                                                                                                                                                                 |
| 7034 | Variable '{0}' implicitly has type '{1}' in some locations where its type cannot be determined.                                                                        | yes         | not tested                                                                                                                                                                 |
| 7035 | Try `npm i --save-dev @types/{1}`...                                                                                                                                   | yes         | not tested                                                                                                                                                                 |
| 7036 | Dynamic import's specifier must be of type 'string', but here has type '{0}'.                                                                                          | yes         | not tested                                                                                                                                                                 |
| 7039 | Mapped object type implicitly has an 'any' template type.                                                                                                              | yes         | not tested                                                                                                                                                                 |
| 7040 | If the '{0}' package actually exposes this module...                                                                                                                   | yes         | not tested                                                                                                                                                                 |
| 7041 | The containing arrow function captures the global value of 'this'.                                                                                                     | yes         | not tested                                                                                                                                                                 |
| 7042 | Module '{0}' was resolved to '{1}', but '--resolveJsonModule' is not used.                                                                                             | yes         | not tested                                                                                                                                                                 |
| 7051 | Parameter has a name but no type. Did you mean '{0}: {1}'?                                                                                                             | yes         | not tested                                                                                                                                                                 |
| 7052 | Element implicitly has an 'any' type because type '{0}' has no index signature. Did you mean to call '{1}'?                                                            | yes         | not tested                                                                                                                                                                 |
| 7053 | Element implicitly has an 'any' type because expression of type '{0}' can't be used to index type '{1}'.                                                               | yes         | not tested                                                                                                                                                                 |
| 7054 | No index signature with a parameter of type '{0}' was found on type '{1}'.                                                                                             | yes         | not tested                                                                                                                                                                 |
| 7055 | '{0}', which lacks return-type annotation, implicitly has an '{1}' yield type.                                                                                         | yes         | not tested                                                                                                                                                                 |
| 7056 | The inferred type of this node exceeds the maximum length the compiler will serialize. An explicit type annotation is needed.                                          | yes         | not tested                                                                                                                                                                 |
| 7057 | 'yield' expression implicitly results in an 'any' type because its containing generator lacks a return-type annotation.                                                | yes         | not tested                                                                                                                                                                 |
| 7058 | If the '{0}' package actually exposes this module, try adding a new declaration (.d.ts)...                                                                             | yes         | not tested                                                                                                                                                                 |
| 7059 | This syntax is reserved in files with the .mts or .cts extension. Use an `as` expression instead.                                                                      | yes         | not tested                                                                                                                                                                 |
| 7060 | This syntax is reserved in files with the .mts or .cts extension. Add a trailing comma or explicit constraint.                                                         | yes         | not tested                                                                                                                                                                 |
| 7061 | A mapped type may not declare properties or methods.                                                                                                                   | yes         | not tested                                                                                                                                                                 |

¹ Per §3.1, "registered" here is close to meaningless as a fixability signal — every code in
this table, and in fact every `Error`-category code TypeScript defines, is "registered."

`7032`/`7033` (accessor implicit-any) are the codes closest in spirit to the
`instanceGetter` fixture, but our actual repro (a self-referential tree-root getter) produced
`7023`, not `7033` — `7033` appears to require a get/set accessor _pair_ with mismatched
inferred types, a different shape we haven't built or tested. This is flagged as an open
question rather than a claim either way.

## 7. What wasn't attempted, and why

A full empirical sweep — compiling a realistic repro and calling `getCodeFixesAtPosition`
for all 1,345 `Error`-category codes — was out of scope for this report; each one requires a
hand-built, realistic-enough repro to trigger, and most (parse errors, config errors,
project-reference errors, JSX-specific errors, `.mts`/`.cts`-specific syntax errors, decorator
errors, etc.) have no plausible relationship to "infer a type from usage evidence," which is
the only kind of problem TypeStat's design attempts to solve. Concretely out of scope by
construction, not by oversight:

- Syntax errors (`1000`–`1999`-ish range): nothing to infer, no usage evidence exists for
  code that doesn't parse.
- Module resolution / project configuration errors (many scattered codes, e.g. `2792`,
  `5023`, `6053`, `18002`): these are project-setup problems, not type-shape problems.
- JSX-specific errors outside the implicit-any family, decorator-metadata errors, and
  `.mts`/`.cts` syntax-restriction errors: narrow, config-dependent domains TypeStat has
  never targeted.

## 8. Rollup

| Bucket                                                                               | Count            | Codes                                                              |
| ------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------ |
| Fixed and verified correct                                                           | 3                | `7006`, `2683`, `2339`                                             |
| Fixed and verified correct, but with a narrower real-world footprint than documented | 1                | `7005` (variables only — see §4)                                   |
| Attempted, verified as a bug (silent no-op)                                          | 1                | `7005` misapplied to property declarations; correct code is `7008` |
| Verified fixable in principle, not attempted by TypeStat at all                      | 1 (spot-checked) | `7008`                                                             |
| Verified **not** fixable by any methodology (TypeScript itself offers no fix)        | 1 (spot-checked) | `7023`                                                             |
| Not attempted, not independently verified either way                                 | ~1,338           | everything else in the 1,345-code `Error` category                 |

The takeaway isn't "TypeStat has 1,338 bugs" — it's that TypeStat's diagnostic-code
mechanism was deliberately scoped to 4 codes, and separately, most of what TypeStat actually
fixes (§5) doesn't go through that mechanism at all. The one real, confirmed bug (`7005`
instead of `7008` for properties) is the only case in this report where TypeStat _claims_ to
cover a code it doesn't actually reach.

## 9. Where this data lives

Raw TSVs backing §6 and the `getSupportedCodeFixes()` claim in §3.1 (all Error-category
diagnostics, the full supported-codefixes list, and the implicit-any family with both
columns) were generated directly from the installed `typescript@5.9.3` package and are
retained as session scratch, not committed to the repo:
`/private/tmp/claude-502/-Users-tgulls-Code-ts-TypeStat/c7c7cd86-4744-4235-a193-b8711befa636/scratchpad/ts-diagnostics/`.
Re-run against any TypeScript version by requiring the `typescript` package and iterating
`ts.Diagnostics`; the exact codes may shift between TypeScript releases (new codes are added
regularly), so treat the specific numbers above as accurate for `5.9.3`, not as permanent.
