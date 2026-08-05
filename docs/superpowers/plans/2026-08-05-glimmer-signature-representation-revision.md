# Glimmer Signature Representation Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rewrite `patchSignatureMember`'s existing-Signature handling so every Glimmer
component's Signature -- new, already a correctly-named interface, differently-named,
a type alias, or an inline literal -- converges on a named `interface <ComponentName>Signature`,
per `docs/superpowers/specs/2026-08-05-glimmer-signature-representation-revision-design.md`.

**Architecture:** `patchSignatureMember` already branches on whether a component class has
an existing Signature type argument. This plan replaces the "patch whatever shape already
exists, in place" branch with a dispatch over four cases (already-correct interface,
differently-named interface, type alias, inline literal), each converging on the same named
interface, plus two guard conditions (naming collision, `.gjs` assumption violation) that
`throw` rather than silently proceed. Renaming reuses the existing `findReferences`-backed
utility (`FileInfoCache.getNodeReferencesAsNodes`) already used elsewhere in the codebase for
usage-evidence gathering -- no new infrastructure.

**Tech Stack:** TypeScript compiler API (`ts.LanguageService`, `ts.TypeChecker`), `automutate`
(`Mutation`, `combineMutations`, `textInsert`/`textSwap`), Vitest.

## Global Constraints

- Signature naming convention: `${componentName}Signature`, where `componentName` is
  `componentClass.name?.text ?? "Component"` -- exactly matches the existing
  `createNewSignatureMutation`'s convention; do not introduce a second convention.
- Rename scope is same-file references only, via the existing
  `FileInfoCache.getNodeReferencesAsNodes` (wrapping `findRelevantNodeReferencesAsNodes` in
  `src/shared/references.ts`). Never add cross-file traversal.
- Rename unconditionally, even when the differently-named interface being renamed has other,
  unrelated in-file uses. Do not add any "is this interface used for something else" detection.
- Naming collisions (target name already bound to an unrelated top-level declaration) and the
  `.gjs`-assumption violation (an existing Signature type argument found in a `.gjs` file) both
  `throw new Error(...)`. Do not construct `MutationsComplaint` directly --
  `findFirstMutations` (`src/shared/runtime.ts`) already catches any thrown error from a
  mutator and wraps it automatically.
- Structural conversions (type alias -> interface, inline literal -> interface) always call
  `request.options.output.stdout(...)` with a notice, even when the member being patched
  doesn't otherwise need a text change.
- Anything this fixer can't resolve into a plain object shape (union, intersection, mapped
  type, etc. as the existing Signature type argument) now `throw`s instead of silently
  returning `undefined`.
- Out of scope, do not touch: `Args` inference, constructor typing, `fixGlimmerElementSignature`,
  `fixGlimmerBlocksSignature`'s own algorithm (only its call site's _inputs_ to
  `patchSignatureMember` matter here, not its logic), and anything under
  `test/cases/fixes/glimmerArgsSignature/`.

## File Structure

- **Modify:** `src/mutations/glimmerSignatures/patchSignatureMember.ts` -- all new dispatch
  logic, guards, and helpers.
- **Modify:** `src/mutations/glimmerSignatures/patchSignatureMember.test.ts` -- upgrade the
  test harness to a real `ts.LanguageService`, update 3 existing test expectations that the
  new behavior changes, add one new test to preserve no-op coverage, and add new tests for
  every new path.
- **Modify:** `test/cases/fixes/glimmerBlocksSignature/multipleValues/expected.gts` --
  regenerate to match the new behavior (this fixture already exercises the inline-literal
  path today).
- **Create:** `test/cases/fixes/glimmerBlocksSignature/renamedSignature/{original.gts,tsconfig.json,typestat.json}`
  -- new end-to-end fixture exercising the rename-a-differently-named-interface path,
  including a second in-file reference to prove multi-reference rename.
- **Modify:** `test/fixGlimmerBlocksSignature.test.ts` -- register the new fixture.

---

### Task 1: Upgrade the `patchSignatureMember` unit-test harness to a real language service

**Files:**

- Modify: `src/mutations/glimmerSignatures/patchSignatureMember.test.ts`

**Interfaces:**

- Consumes: nothing new -- this task only changes test infrastructure, not any production code.
- Produces: `createRequest(sourceText: string): FileMutationsRequest`, now backed by a real
  `ts.LanguageService` (so `request.fileInfoCache.getNodeReferencesAsNodes(...)` and
  `request.options.output.stdout(...)` both work for real in later tasks) instead of the
  current `{} as ts.LanguageService` stub.

Today's `createRequest` builds a `ts.Program` via `ts.createCompilerHost`, but stubs
`languageService: {} as ts.LanguageService` and omits `options.output` entirely. Task 2 needs
both `findReferences` (via `fileInfoCache`) and `output.stdout` to actually work, so this task
swaps the whole helper for one backed by a real in-memory `ts.LanguageService`, verifying the
5 existing tests still pass completely unchanged.

- [ ] **Step 1: Replace `createRequest` with a real-language-service version**

Replace the entire `createRequest` function in
`src/mutations/glimmerSignatures/patchSignatureMember.test.ts` with:

```ts
const createRequest = (
	sourceText: string,
	requestFileName: string = fileName,
): FileMutationsRequest => {
	const files = new Map([[requestFileName, sourceText]]);

	const languageServiceHost: ts.LanguageServiceHost = {
		fileExists: (requestedFileName) => files.has(requestedFileName),
		getCompilationSettings: () => ({}),
		getCurrentDirectory: () => "/virtual",
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		getScriptFileNames: () => [requestFileName],
		getScriptSnapshot: (requestedFileName) => {
			const contents = files.get(requestedFileName);
			return contents === undefined
				? undefined
				: ts.ScriptSnapshot.fromString(contents);
		},
		getScriptVersion: () => "0",
		readFile: (requestedFileName) => files.get(requestedFileName),
	};

	const languageService = ts.createLanguageService(
		languageServiceHost,
		ts.createDocumentRegistry(),
	);
	const program = languageService.getProgram();
	if (program === undefined) {
		throw new Error("Expected a program");
	}

	const sourceFile = program.getSourceFile(requestFileName);
	if (sourceFile === undefined) {
		throw new Error("Expected a source file");
	}

	const filteredNodes = new Set<ts.Node>();
	const services = {
		glimmerTransforms: new Map(),
		languageService,
		printers: {} as never,
		program,
	};

	return {
		fileInfoCache: new FileInfoCache(filteredNodes, services, sourceFile),
		filteredNodes,
		nameGenerator: new NameGenerator(requestFileName),
		options: {
			output: {
				// eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
				stderr: () => {},
				// eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
				stdout: () => {},
			},
			parsedTsConfig: { options: {} },
		} as never,
		services,
		sourceFile,
	};
};
```

This drops the old `ts.createProgram`/`ts.createCompilerHost` approach entirely -- the
`program` now comes from `languageService.getProgram()`, which is what every production code
path (`request.services.program`) actually uses too. The new optional `requestFileName`
parameter (defaulting to the existing `fileName` constant) is unused by today's 5 tests but
lets Task 2 build a `.gjs`-named request without unsafely spreading a `ts.SourceFile` (which
would lose its prototype methods like `getStart()`).

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `npx vitest run src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: all 5 existing tests still PASS, unchanged. If any fail, the harness swap
introduced a behavior difference -- do not proceed to Task 2 until all 5 pass exactly as
they did before this change.

- [ ] **Step 3: Commit**

```bash
git add src/mutations/glimmerSignatures/patchSignatureMember.test.ts
git commit -m "test(glimmer-signatures): back patchSignatureMember's test harness with a real language service"
```

---

### Task 2: Always converge on a named interface Signature

**Files:**

- Modify: `src/mutations/glimmerSignatures/patchSignatureMember.ts`
- Modify: `src/mutations/glimmerSignatures/patchSignatureMember.test.ts`

**Interfaces:**

- Consumes: `FileInfoCache.getNodeReferencesAsNodes(node: ts.Node): readonly ts.Node[] | undefined`
  (`src/shared/FileInfoCache.ts`, already exists, unchanged); `request.options.output.stdout(line: string): void`
  (`src/output/types.ts`, already exists, unchanged); `combineMutations`, `textInsert`, `textSwap`
  (already imported in the file today).
- Produces: `patchSignatureMember`'s public signature is unchanged
  (`(request, componentClass, memberName, newTypeText) => Mutation | undefined`), but it now
  throws in two new cases (naming collision, `.gjs` assumption violation, and unresolvable
  existing-Signature shape) instead of always returning a value.

This is one cohesive rewrite of one function's internals -- the four new/changed branches
(already-correct interface, differently-named interface, type alias, inline literal, plus the
now-throwing catch-all) share helpers and can't be meaningfully split into separate
reviewable tasks without leaving the file in a non-compiling intermediate state. Write and
run all the new/changed tests first (they'll fail against today's code), then implement the
whole rewrite in one step, then confirm everything passes together.

- [ ] **Step 1: Update the 3 existing tests whose expectations the new behavior changes**

All three of these currently exercise an **inline literal** Signature
(`Component<{ ... }>`). Today, `patchSignatureMember` patches an inline literal in place.
Under the new behavior, every inline literal gets extracted into a named interface -- so
all three tests' expected output changes shape, and the third one (previously a no-op) now
produces a real mutation.

Replace this test:

```ts
it("adds a missing member to an existing inline Signature literal", () => {
	const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`class Highlight extends Component<{ Args: {};\n\tElement: HTMLDivElement;\n }> {}`,
	);
});
```

with:

```ts
it("extracts an inline Signature literal missing a member into a named interface", () => {
	const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	// Run this test once the implementation exists (Step 3) to see the real output,
	// then confirm the body text below matches -- the interface body is a direct
	// character-offset splice of the original literal's own text, so exact
	// whitespace depends on getEndInsertionPoint's existing (unchanged) logic.
	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\n\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});
```

Replace this test:

```ts
it("replaces a differing existing member's type in an inline Signature literal", () => {
	const sourceText = `class Highlight extends Component<{ Element: HTMLSpanElement }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`class Highlight extends Component<{ Element: HTMLDivElement }> {}`,
	);
});
```

with:

```ts
it("extracts an inline Signature literal while replacing a differing member's type", () => {
	const sourceText = `class Highlight extends Component<{ Element: HTMLSpanElement }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Element: HTMLDivElement }\n\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});
```

Replace this test (previously asserted a no-op; an inline literal now always extracts, even
when the member itself needs no change):

```ts
it("does not mutate when the existing member's type already matches", () => {
	const sourceText = `class Highlight extends Component<{ Element: HTMLDivElement }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(mutation).toBeUndefined();
});
```

with:

```ts
it("still extracts an inline Signature literal even when the member's type already matches", () => {
	const sourceText = `class Highlight extends Component<{ Element: HTMLDivElement }> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Element: HTMLDivElement }\n\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});
```

- [ ] **Step 2: Add a new test preserving true no-op coverage (named interface, member already correct)**

The case above no longer covers "nothing happens when nothing needs to change" -- add this
new test, adjacent to the existing "patches an existing named interface Signature in place"
test, to keep that coverage using a shape that's genuinely still a no-op:

```ts
it("does not mutate an already-correctly-named interface whose member already matches", () => {
	const sourceText = `interface HighlightSignature { Element: HTMLDivElement }\nclass Highlight extends Component<HighlightSignature> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(mutation).toBeUndefined();
});
```

- [ ] **Step 3: Add new tests for every new path**

Add all of these new `it(...)` blocks inside the existing `describe("patchSignatureMember", ...)`:

```ts
it("renames a differently-named existing interface and every same-file reference", () => {
	const sourceText = `interface ListSignature { Args: {} }\nfunction describe(args: ListSignature): string { return String(args); }\nclass Highlight extends Component<ListSignature> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nfunction describe(args: HighlightSignature): string { return String(args); }\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});

it("converts a same-named type alias to an interface", () => {
	const sourceText = `type HighlightSignature = { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});

it("converts a differently-named type alias to an interface and renames references", () => {
	const sourceText = `type ListSignature = { Args: {} }\nfunction describe(args: ListSignature): string { return String(args); }\nclass Highlight extends Component<ListSignature> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		"HTMLDivElement",
	);

	expect(applyMutation(sourceText, mutation)).toBe(
		`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nfunction describe(args: HighlightSignature): string { return String(args); }\nclass Highlight extends Component<HighlightSignature> {}`,
	);
});

it("emits a warning when converting a type alias to an interface", () => {
	const sourceText = `type HighlightSignature = { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
	const request = createRequest(sourceText);
	const stdout = vi.fn();
	(request.options.output as { stdout: typeof stdout }).stdout = stdout;
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	patchSignatureMember(request, componentClass, "Element", "HTMLDivElement");

	expect(stdout).toHaveBeenCalledOnce();
});

it("emits a warning when extracting an inline literal into an interface", () => {
	const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
	const request = createRequest(sourceText);
	const stdout = vi.fn();
	(request.options.output as { stdout: typeof stdout }).stdout = stdout;
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	patchSignatureMember(request, componentClass, "Element", "HTMLDivElement");

	expect(stdout).toHaveBeenCalledOnce();
});

it("throws when the target Signature name collides with an unrelated declaration", () => {
	const sourceText = `interface ListSignature { Args: {} }\ninterface HighlightSignature { Blocks: {} }\nclass Highlight extends Component<ListSignature> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	expect(() =>
		patchSignatureMember(request, componentClass, "Element", "HTMLDivElement"),
	).toThrow(/HighlightSignature/);
});

it("throws when a .gjs file unexpectedly has an existing Signature type argument", () => {
	const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
	const request = createRequest(sourceText, "/virtual/component.gjs");
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	expect(() =>
		patchSignatureMember(request, componentClass, "Element", "HTMLDivElement"),
	).toThrow(/\.gjs/);
});

it("throws when the existing Signature type argument can't be resolved into an object shape", () => {
	const sourceText = `type Combined = { Args: {} } | { Blocks: {} };\nclass Highlight extends Component<Combined> {}`;
	const request = createRequest(sourceText);
	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		throw new Error("Expected a component class");
	}

	expect(() =>
		patchSignatureMember(request, componentClass, "Element", "HTMLDivElement"),
	).toThrow(/Could not resolve/);
});
```

Add `vi` to the existing `import { describe, expect, it } from "vitest";` line, making it
`import { describe, expect, it, vi } from "vitest";`.

- [ ] **Step 4: Run the test file and confirm the new/changed tests fail**

Run: `npx vitest run src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: FAIL -- the tests from Steps 1-3 don't match today's behavior yet (today's code
still patches inline literals in place, never renames, never throws on collision/`.gjs`, and
still returns `undefined` for unresolvable shapes instead of throwing).

- [ ] **Step 5: Implement the rewrite**

Replace the entire contents of `src/mutations/glimmerSignatures/patchSignatureMember.ts` with:

```ts
import { combineMutations, Mutation } from "automutate";
import ts from "typescript";

import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { getStaticNameOfProperty } from "../../shared/names.js";
import {
	isNodeWithType,
	PropertySignatureWithType,
} from "../../shared/nodeTypes.js";
import { textInsert, textSwap } from "../text-mutations.js";

export type SignatureMembersNode = ts.InterfaceDeclaration | ts.TypeLiteralNode;

type ExistingSignatureSource =
	| {
			readonly declaration: ts.InterfaceDeclaration;
			readonly kind: "interface";
	  }
	| {
			readonly declaration: ts.TypeAliasDeclaration;
			readonly kind: "typeAlias";
	  }
	| { readonly kind: "inlineLiteral"; readonly literal: ts.TypeLiteralNode };

export const patchSignatureMember = (
	request: FileMutationsRequest,
	componentClass: ts.ClassDeclaration,
	memberName: "Args" | "Blocks" | "Element",
	newTypeText: string,
): Mutation | undefined => {
	const heritageType = findExtendsType(componentClass);
	if (heritageType === undefined) {
		return undefined;
	}

	if (
		heritageType.typeArguments === undefined ||
		heritageType.typeArguments.length === 0
	) {
		return createNewSignatureMutation(
			componentClass,
			heritageType,
			memberName,
			newTypeText,
		);
	}

	ensureNotGlimmerJsFileWithExistingSignature(request.sourceFile);

	const [signatureTypeArgument] = heritageType.typeArguments;
	const source = resolveExistingSignatureSource(request, signatureTypeArgument);
	if (source === undefined) {
		throw new Error(
			`Could not resolve the existing Signature type argument on '${componentClass.name?.text ?? "the component"}' in '${request.sourceFile.fileName}' into a plain object shape (interface, type alias of an object literal, or inline literal). Refusing to guess how to normalize it.`,
		);
	}

	const componentName = componentClass.name?.text ?? "Component";
	const targetName = `${componentName}Signature`;

	if (source.kind === "interface") {
		if (source.declaration.name.text === targetName) {
			return patchExistingSignatureMember(
				request,
				source.declaration,
				memberName,
				newTypeText,
			);
		}

		ensureNoNameCollision(request.sourceFile, targetName, undefined);
		return renameSignatureDeclaration(
			request,
			source.declaration,
			targetName,
			memberName,
			newTypeText,
		);
	}

	if (source.kind === "typeAlias") {
		ensureNoNameCollision(request.sourceFile, targetName, source.declaration);
		warnAboutSignatureConversion(
			request,
			`type alias '${source.declaration.name.text}'`,
			targetName,
		);
		return convertTypeAliasAndPatch(
			request,
			source.declaration,
			targetName,
			memberName,
			newTypeText,
		);
	}

	ensureNoNameCollision(request.sourceFile, targetName, undefined);
	warnAboutSignatureConversion(request, "an inline literal", targetName);
	return extractInlineLiteralAndPatch(
		request,
		componentClass,
		source.literal,
		targetName,
		memberName,
		newTypeText,
	);
};

const findExtendsType = (
	componentClass: ts.ClassDeclaration,
): ts.ExpressionWithTypeArguments | undefined => {
	for (const heritageClause of componentClass.heritageClauses ?? []) {
		if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
			return heritageClause.types[0];
		}
	}

	return undefined;
};

const createNewSignatureMutation = (
	componentClass: ts.ClassDeclaration,
	heritageType: ts.ExpressionWithTypeArguments,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const componentName = componentClass.name?.text ?? "Component";
	const signatureName = `${componentName}Signature`;

	const newInterfaceInsertion = textInsert(
		`interface ${signatureName} {\n\t${memberName}: ${newTypeText};\n}\n\n`,
		componentClass.getStart(),
	);
	const newTypeArgumentInsertion = textInsert(
		`<${signatureName}>`,
		heritageType.expression.end,
	);

	return combineMutations(newInterfaceInsertion, newTypeArgumentInsertion);
};

const resolveExistingSignatureSource = (
	request: FileMutationsRequest,
	signatureTypeArgument: ts.TypeNode,
): ExistingSignatureSource | undefined => {
	if (ts.isTypeLiteralNode(signatureTypeArgument)) {
		return { kind: "inlineLiteral", literal: signatureTypeArgument };
	}

	if (!ts.isTypeReferenceNode(signatureTypeArgument)) {
		return undefined;
	}

	const typeChecker = request.services.program.getTypeChecker();
	const symbol = typeChecker.getSymbolAtLocation(
		signatureTypeArgument.typeName,
	);
	const declaration = symbol?.declarations?.[0];

	if (declaration === undefined) {
		return undefined;
	}

	if (ts.isInterfaceDeclaration(declaration)) {
		return { declaration, kind: "interface" };
	}

	if (
		ts.isTypeAliasDeclaration(declaration) &&
		ts.isTypeLiteralNode(declaration.type)
	) {
		return { declaration, kind: "typeAlias" };
	}

	return undefined;
};

const renameSignatureDeclaration = (
	request: FileMutationsRequest,
	declaration: ts.InterfaceDeclaration,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const declarationNameSwap = textSwap(
		targetName,
		declaration.name.getStart(request.sourceFile),
		declaration.name.end,
	);
	const referenceMutations = createReferenceRenameMutations(
		request,
		declaration.name,
		targetName,
	);
	const memberMutation = patchExistingSignatureMember(
		request,
		declaration,
		memberName,
		newTypeText,
	);

	const mutations: Mutation[] = [declarationNameSwap, ...referenceMutations];
	if (memberMutation !== undefined) {
		mutations.push(memberMutation);
	}

	return combineMutations(...mutations);
};

const convertTypeAliasAndPatch = (
	request: FileMutationsRequest,
	declaration: ts.TypeAliasDeclaration,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const literal = declaration.type as ts.TypeLiteralNode;

	const keywordSwap = textSwap(
		`interface ${targetName} `,
		declaration.getStart(request.sourceFile),
		literal.getStart(request.sourceFile),
	);
	const referenceMutations =
		declaration.name.text === targetName
			? []
			: createReferenceRenameMutations(request, declaration.name, targetName);
	const memberMutation = patchExistingSignatureMember(
		request,
		literal,
		memberName,
		newTypeText,
	);

	const mutations: Mutation[] = [keywordSwap, ...referenceMutations];
	if (memberMutation !== undefined) {
		mutations.push(memberMutation);
	}

	return combineMutations(...mutations);
};

const extractInlineLiteralAndPatch = (
	request: FileMutationsRequest,
	componentClass: ts.ClassDeclaration,
	literal: ts.TypeLiteralNode,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const bodyText = buildSignatureBodyText(
		request,
		literal,
		memberName,
		newTypeText,
	);

	const newInterfaceInsertion = textInsert(
		`interface ${targetName} ${bodyText}\n\n`,
		componentClass.getStart(),
	);
	const typeArgumentSwap = textSwap(
		targetName,
		literal.getStart(request.sourceFile),
		literal.end,
	);

	return combineMutations(newInterfaceInsertion, typeArgumentSwap);
};

const buildSignatureBodyText = (
	request: FileMutationsRequest,
	literal: ts.TypeLiteralNode,
	memberName: string,
	newTypeText: string,
): string => {
	const literalStart = literal.getStart(request.sourceFile);
	const literalText = literal.getText(request.sourceFile);
	const existingMember = findExistingMember(literal, memberName);

	if (existingMember === undefined) {
		const { insertionPoint, needsLeadingSeparator } = getEndInsertionPoint(
			request.sourceFile,
			literal,
		);
		const separator = needsLeadingSeparator ? ";\n\t" : "";
		const offset = insertionPoint - literalStart;

		return (
			literalText.slice(0, offset) +
			`${separator}${memberName}: ${newTypeText};\n` +
			literalText.slice(offset)
		);
	}

	const typeStartOffset =
		existingMember.type.getStart(request.sourceFile) - literalStart;
	const typeEndOffset = existingMember.type.end - literalStart;

	return (
		literalText.slice(0, typeStartOffset) +
		newTypeText +
		literalText.slice(typeEndOffset)
	);
};

const createReferenceRenameMutations = (
	request: FileMutationsRequest,
	nameNode: ts.Identifier,
	targetName: string,
): Mutation[] => {
	const referencingNodes =
		request.fileInfoCache.getNodeReferencesAsNodes(nameNode) ?? [];

	return referencingNodes.map((node) =>
		textSwap(targetName, node.getStart(request.sourceFile), node.end),
	);
};

const ensureNoNameCollision = (
	sourceFile: ts.SourceFile,
	targetName: string,
	excludeDeclaration: ts.Statement | undefined,
): void => {
	const existing = getTopLevelDeclaredNames(sourceFile).get(targetName);
	if (existing !== undefined && existing !== excludeDeclaration) {
		throw new Error(
			`Cannot normalize a Glimmer component's Signature to '${targetName}' in '${sourceFile.fileName}': that name is already bound by an unrelated declaration.`,
		);
	}
};

const getTopLevelDeclaredNames = (
	sourceFile: ts.SourceFile,
): Map<string, ts.Statement> => {
	const namesToStatements = new Map<string, ts.Statement>();

	for (const statement of sourceFile.statements) {
		if (
			(ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement)) &&
			statement.name !== undefined
		) {
			namesToStatements.set(statement.name.text, statement);
			continue;
		}

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					namesToStatements.set(declaration.name.text, statement);
				}
			}
		}
	}

	return namesToStatements;
};

const ensureNotGlimmerJsFileWithExistingSignature = (
	sourceFile: ts.SourceFile,
): void => {
	if (/\.gjs$/i.test(sourceFile.fileName)) {
		throw new Error(
			`Found an existing Signature type argument in a .gjs file ('${sourceFile.fileName}'), which should be impossible -- .gjs files can't contain TypeScript generic syntax. This file may already be in a broken state.`,
		);
	}
};

const warnAboutSignatureConversion = (
	request: FileMutationsRequest,
	from: string,
	targetName: string,
): void => {
	request.options.output.stdout(
		`Converting ${from} to interface '${targetName}' for a Glimmer component's Signature in '${request.sourceFile.fileName}'.\n`,
	);
};

const patchExistingSignatureMember = (
	request: FileMutationsRequest,
	node: SignatureMembersNode,
	memberName: string,
	newTypeText: string,
): Mutation | undefined => {
	const existingMember = findExistingMember(node, memberName);

	if (existingMember === undefined) {
		const { insertionPoint, needsLeadingSeparator } = getEndInsertionPoint(
			request.sourceFile,
			node,
		);
		const separator = needsLeadingSeparator ? ";\n\t" : "";

		return textInsert(
			`${separator}${memberName}: ${newTypeText};\n`,
			insertionPoint,
		);
	}

	const existingTypeText = request.sourceFile.text.slice(
		existingMember.type.getStart(request.sourceFile),
		existingMember.type.end,
	);
	if (existingTypeText === newTypeText) {
		return undefined;
	}

	return textSwap(
		newTypeText,
		existingMember.type.getStart(request.sourceFile),
		existingMember.type.end,
	);
};

const findExistingMember = (
	node: SignatureMembersNode,
	memberName: string,
): PropertySignatureWithType | undefined => {
	for (const member of node.members) {
		if (!ts.isPropertySignature(member) || !isNodeWithType(member)) {
			continue;
		}

		if (getStaticNameOfProperty(member.name) === memberName) {
			return member;
		}
	}

	return undefined;
};

const getEndInsertionPoint = (
	sourceFile: ts.SourceFile,
	node: SignatureMembersNode,
): { insertionPoint: number; needsLeadingSeparator: boolean } => {
	if (node.members.length === 0) {
		return { insertionPoint: node.end - 1, needsLeadingSeparator: false };
	}

	const lastMember = node.members[node.members.length - 1];
	const lastCharacter = sourceFile.text[lastMember.end - 1];
	const hasTrailingSeparator = lastCharacter === ";" || lastCharacter === ",";

	return {
		insertionPoint: Math.min(
			lastMember.end + (hasTrailingSeparator ? 1 : 0),
			node.end,
		),
		needsLeadingSeparator: !hasTrailingSeparator,
	};
};
```

This keeps `findExtendsType`, `createNewSignatureMutation`, `patchExistingSignatureMember`,
`findExistingMember`, and `getEndInsertionPoint` byte-for-byte identical to today -- only
`resolveSignatureMembersNode` is replaced (by `resolveExistingSignatureSource`, returning a
richer discriminated result instead of a flattened node), and everything downstream of it is
new.

- [ ] **Step 6: Run the test file and fix any mismatches**

Run: `npx vitest run src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: all tests PASS. If a hand-derived expected string in Steps 1-3 doesn't match the
real output byte-for-byte, inspect the actual output Vitest reports: if it's the same
structural shape (interface extracted, member added/replaced, references renamed) and only
differs in exact whitespace, update the test's expected string to match the real output --
don't fight the implementation to match a hand-typed guess. If the actual output is
structurally wrong (wrong member content, a reference not renamed, etc.), that's a real bug
in Step 5's implementation -- fix the implementation, not the test.

- [ ] **Step 7: Run the full repo test suite and lint**

Run: `npx vitest run`
Expected: PASS, except `test/fixGlimmerBlocksSignature.test.ts`'s
`"infers the Blocks member from a named yield"` test, which is now expected to FAIL (it
exercises `test/cases/fixes/glimmerBlocksSignature/multipleValues`, an inline-literal fixture
whose `expected.gts` hasn't been updated yet -- that's Task 3). No other test should fail.

Run: `npx eslint src/mutations/glimmerSignatures/patchSignatureMember.ts src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/mutations/glimmerSignatures/patchSignatureMember.ts src/mutations/glimmerSignatures/patchSignatureMember.test.ts
git commit -m "feat(glimmer-signatures): always converge Signature representation on a named interface"
```

---

### Task 3: Update fixtures for the new behavior

**Files:**

- Modify: `test/cases/fixes/glimmerBlocksSignature/multipleValues/expected.gts`
- Create: `test/cases/fixes/glimmerBlocksSignature/renamedSignature/original.gts`
- Create: `test/cases/fixes/glimmerBlocksSignature/renamedSignature/tsconfig.json`
- Create: `test/cases/fixes/glimmerBlocksSignature/renamedSignature/typestat.json`
- Modify: `test/fixGlimmerBlocksSignature.test.ts`

**Interfaces:**

- Consumes: Task 2's rewritten `patchSignatureMember`, exercised end-to-end through the real
  `rewriteModule` pipeline via `runMutationTest` (`src/tests/testSetup.ts`, unchanged).
- Produces: nothing further consumes this task -- it's the last one in this plan.

- [ ] **Step 1: Regenerate `multipleValues`'s expected output**

This fixture's `class UnorderedList extends Component<{ Args: UnorderedListArgs; }>` is an
inline literal -- exactly the case that now always extracts into a named interface. Delete
the stale expected file and let the test regenerate it:

```bash
rm test/cases/fixes/glimmerBlocksSignature/multipleValues/expected.gts
npx vitest run test/fixGlimmerBlocksSignature.test.ts -u
```

Expected: the `"infers the Blocks member from a named yield"` test passes and writes a new
`expected.gts`.

- [ ] **Step 2: Inspect the regenerated file**

Read `test/cases/fixes/glimmerBlocksSignature/multipleValues/expected.gts`. Confirm it shows:
an `interface UnorderedListSignature { ... }` declaration (containing both the original
`Args: UnorderedListArgs;` member and a new `Blocks: { default: [string, number]; };`
member) inserted above the class, and `export default class UnorderedList extends Component<UnorderedListSignature>`
in the `extends` clause. If instead it still shows an inline literal, or the `Blocks` member
is missing, or `UnorderedListArgs`'s own declaration was altered, that's a bug in Task 2 --
go back and fix it there, don't hand-edit this fixture to paper over it.

- [ ] **Step 3: Write the new `renamedSignature` fixture's `original.gts`**

```

import Component from "@glimmer/component";

interface SharedListSignature {
	Args: {
		items: string[];
	};
}

function describeArgs(args: SharedListSignature["Args"]): string {
	return args.items.join(", ");
}

export default class UnorderedList extends Component<SharedListSignature> {
	<template>
		<ul>
			{{#each @items as |item|}}
				<li>{{yield item}}</li>
			{{/each}}
		</ul>
	</template>
}
```

This exercises the full rename mechanism end-to-end: the interface's own declaration name,
its reference inside `describeArgs`'s parameter type (a reference _unrelated_ to being this
component's Signature -- proving the "rename unconditionally" decision), and its reference in
the `extends` clause all need to become `UnorderedListSignature`, alongside the new `Blocks`
member being added.

- [ ] **Step 4: Write `tsconfig.json` and `typestat.json`**

`test/cases/fixes/glimmerBlocksSignature/renamedSignature/tsconfig.json`:

```json
{
	"compilerOptions": {
		"module": "esnext",
		"moduleResolution": "bundler",
		"strict": true,
		"target": "ES2022",
		"types": ["ember-source/types"]
	},
	"files": ["actual.gts"]
}
```

`test/cases/fixes/glimmerBlocksSignature/renamedSignature/typestat.json`:

```json
{
	"fixes": {
		"glimmerBlocksSignature": true,
		"glimmerElementSignature": true,
		"importExtensions": true,
		"incompleteTypes": true,
		"missingProperties": true,
		"noImplicitAny": true,
		"noImplicitThis": true,
		"noInferableTypes": true,
		"strictNonNullAssertions": true
	}
}
```

(Both match the existing `multipleValues`/`namedBlocks` fixtures' settings exactly.)

- [ ] **Step 5: Register the new fixture in the test file**

Add this `it(...)` block inside `describe("Glimmer Blocks Signature", ...)` in
`test/fixGlimmerBlocksSignature.test.ts`, after the existing two:

```ts
it("renames a differently-named existing Signature interface and its references", async () => {
	const caseDir = path.join(
		import.meta.dirname,
		"./cases/fixes/glimmerBlocksSignature/renamedSignature",
	);
	const { actualContent, expectedFilePath, options } =
		await runMutationTest(caseDir);
	await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
	expect(options).toMatchSnapshot("options");
}, 10000);
```

- [ ] **Step 6: Run the new test to generate its expected output**

Run: `npx vitest run test/fixGlimmerBlocksSignature.test.ts`
Expected: PASS, and `test/cases/fixes/glimmerBlocksSignature/renamedSignature/expected.gts`
gets created (via `toMatchFileSnapshot`, since it doesn't exist yet).

- [ ] **Step 7: Inspect the generated expected output**

Read the new `expected.gts`. Confirm: the interface declaration, `describeArgs`'s parameter
type, and the `extends` clause all say `UnorderedListSignature` (not `SharedListSignature`),
and the interface has both an `Args` member (unchanged from the original) and a new `Blocks: { default: [string]; }`
member (a single `string` argument, since `{{yield item}}` yields one arg, and `item` comes
from destructuring `@items: string[]`). If any reference was missed, or the wrong number of
`Blocks` members appears, that's a bug in Task 2 -- go fix it there.

- [ ] **Step 8: Run the full repo test suite and lint**

Run: `npx vitest run`
Expected: all tests PASS, including the previously-known-failing `multipleValues` test from
Task 2 Step 7.

Run: `npx eslint .`
Expected: no new errors beyond the pre-existing, unrelated ones already present on this
branch (`bin/typestat.mjs`, any untracked scratch docs).

Run: `npx prettier --check test/cases/fixes/glimmerBlocksSignature/ test/fixGlimmerBlocksSignature.test.ts`
Expected: all matched files use Prettier code style. If not, run
`npx prettier --write test/cases/fixes/glimmerBlocksSignature/ test/fixGlimmerBlocksSignature.test.ts`
and re-check.

- [ ] **Step 9: Commit**

```bash
git add test/cases/fixes/glimmerBlocksSignature/multipleValues/expected.gts test/cases/fixes/glimmerBlocksSignature/renamedSignature test/fixGlimmerBlocksSignature.test.ts
git commit -m "test(glimmer-signatures): update multipleValues and add a renamed-Signature fixture"
```
