# Glimmer `Element` + `Blocks` Signature Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer and write a `.gts` component's `Element` and `Blocks` Signature members from real template usage (`...attributes` spreads and `{{yield ...}}` calls), and let TypeStat's existing 7 built-in fixers see template-only usage evidence for free, with no per-fixer code changes.

**Architecture:** Build a shared Glimmer-transform layer on top of `@glint/ember-tsc`'s public `rewriteModule` export, wire it into `createLanguageServices` so `.gts`/`.gjs` files are type-checked via their desugared (transformed) content instead of raw text, add one central position-remap choke point so every fixer's output still lands at the right position in the real file, then add two new fixers (`fixGlimmerElementSignature`, `fixGlimmerBlocksSignature`) that read inferred types directly off the transformed AST's `__glintDSL__.applySplattributes(...)`/`__glintDSL__.yieldToBlock(...)` call sites and patch them into the component's `Signature` type.

**Tech Stack:** TypeScript 5.9, `@glint/ember-tsc` (Glint v2 core), Vitest (existing repo conventions).

**Spec:** `docs/superpowers/specs/2026-08-03-glimmer-signature-inference-design.md`. Related, independent, not-yet-executed plan: `docs/superpowers/plans/2026-08-03-gjs-to-gts-rename-support.md` (subsystem 1 -- the `.gjs`→`.gts` rename; this plan does not depend on it, since `.gts`-file tsconfigs can be written directly for these fixtures).

## Global Constraints

- Repo pins all `dependencies`/`devDependencies` to exact versions (no `^`/`~`); match that for every new package added below.
- `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` per root `tsconfig.json` -- every new relative import must use an explicit `.js` extension.
- `"strict": true` -- no new file may need a suppression to compile.
- Tabs for indentation (per `.prettierrc.json`); ESM imports throughout.
- `Fixes` interface property names have no `fix` prefix (e.g. `missingProperties`, not `fixMissingProperties`) -- the new flags are `glimmerElementSignature` and `glimmerBlocksSignature`. The fixer directories/exported functions keep the `fix` prefix (`fixGlimmerElementSignature`, `fixGlimmerBlocksSignature`), matching every existing fixer.
- No comments explaining _what_ code does; only add a comment where the _why_ is non-obvious.
- Every new built-in fixer needs: an entry in `builtInFileMutators` (alphabetically ordered, matching existing convention), a `Fixes` flag + default (`false`) in `fillOutRawOptions.ts`, a `docs/Fixes.md` entry + top-JSON-block entry, a `README.md` under its own directory (matching `fixMissingProperties/README.md`'s structure: title, one-line description, "Use Cases", "Configuration", "Mutations" with diff examples), and an end-to-end fixture test under `test/cases/fixes/<flagName>/` run via `test/<FixerName>.test.ts` + `runMutationTest`.
- Verified via a real scratch install of `@glint/ember-tsc@1.8.14` + `typescript@5.9.3` during planning (pinned to `1.8.14` rather than the newer `1.10.0` because `1.10.0` was published the same day as this plan and is blocked by the sandbox's supply-chain `minimumReleaseAge` protection; `1.8.14`, a week old, was independently re-verified during planning to produce byte-identical `rewriteModule` output for `applySplattributes`/`yieldToBlock`/`getOriginalOffset`) (not read off `.d.ts` alone): `rewriteModule` returns a **non-null** `TransformedModule` with a populated `.errors` array for _recoverable_ template parse errors (e.g. `<template>{{#each}}</template>`) -- it only returns `null` when there is no template at all in the script (confirmed with `export const x = 1;`). Code must not assume `null` means "malformed template."
- Verified real transformed-output shapes (do not re-derive these from first principles -- they are copied verbatim from actual `rewriteModule` output during planning):
  - An element with `...attributes` produces, in the same lexical block as its `emitElement(...)` call: `__glintDSL__.applySplattributes(__glintRef__.element, __glintY__.element);` where `__glintY__` is that block's `emitElement` result. There is at most one such call per template (Glimmer itself forbids more than one `...attributes` per template), so no disambiguation logic beyond "find the one call" is needed.
  - A `{{yield ...}}` (named or default block) produces a **curried call**: `__glintDSL__.yieldToBlock(__glintRef__, "<blockName>")(<arg0>, <arg1>, ...)`, regardless of what control-flow (`{{#each}}`, `{{#let}}`, etc.) surrounds it -- the yielded arguments are always plain, independently-checkable identifiers by the time they reach this call. No Glimmer-control-flow-aware desugaring logic is needed to read them.

---

### Task 1: Shared Glimmer-transform primitives

**Files:**

- Create: `src/services/glimmer/index.ts`
- Test: `src/services/glimmer/index.test.ts`
- Modify: `package.json` (add `@glint/ember-tsc` to `dependencies`, `@glimmer/component` to `devDependencies`)

**Interfaces:**

- Produces: `isGlimmerFile(fileName: string): boolean`; `glimmerFileExtensionInfos: readonly ts.FileExtensionInfo[]`; `computeGlimmerTransform(fileName: string, rawContents: string, rootDir: string): TransformedModule | null` (type re-exported from `@glint/ember-tsc/transform`).

- [ ] **Step 1: Add dependencies**

```bash
pnpm add @glint/ember-tsc@1.8.14
pnpm add -D @glimmer/component@2.1.1
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/services/glimmer/index.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeGlimmerTransform, isGlimmerFile } from "./index.js";

describe("isGlimmerFile", () => {
	it.each([
		["component.gts", true],
		["component.gjs", true],
		["Component.GTS", true],
		["component.ts", false],
		["component.tsx", false],
		["component.js", false],
	])("%s -> %s", (fileName, expected) => {
		expect(isGlimmerFile(fileName)).toBe(expected);
	});
});

describe("computeGlimmerTransform", () => {
	const rootDir = path.join(import.meta.dirname, "../../..");

	it("transforms a .gts component's <template> into type-checkable TypeScript", () => {
		const rawContents = `
class Highlight {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
`;

		const transformed = computeGlimmerTransform(
			"highlight.gts",
			rawContents,
			rootDir,
		);

		expect(transformed).not.toBeNull();
		expect(transformed?.transformedContents).toContain("__glintDSL__");
		expect(transformed?.transformedContents).toContain("applySplattributes");
		expect(transformed?.transformedContents).toContain("yieldToBlock");
	});

	it("returns a TransformedModule with errors for malformed template syntax, not null", () => {
		const transformed = computeGlimmerTransform(
			"broken.gts",
			"<template>{{#each}}</template>",
			rootDir,
		);

		expect(transformed).not.toBeNull();
		expect(transformed?.errors.length).toBeGreaterThan(0);
	});

	it("returns null when there is no template to transform", () => {
		const transformed = computeGlimmerTransform(
			"empty.gts",
			"export const x = 1;",
			rootDir,
		);

		expect(transformed).toBeNull();
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- src/services/glimmer/index.test.ts`
Expected: FAIL with "Cannot find module './index.js'" (file doesn't exist yet)

- [ ] **Step 4: Write the implementation**

```ts
// src/services/glimmer/index.ts
import { createDefaultConfig } from "@glint/ember-tsc";
import {
	rewriteModule,
	type TransformedModule,
} from "@glint/ember-tsc/transform";
import ts from "typescript";

export const glimmerFileExtensionInfos: readonly ts.FileExtensionInfo[] = [
	{
		extension: ".gts",
		isMixedContent: false,
		scriptKind: ts.ScriptKind.Deferred,
	},
	{
		extension: ".gjs",
		isMixedContent: false,
		scriptKind: ts.ScriptKind.Deferred,
	},
];

const glimmerFileNamePattern = /\.g(?:js|ts)$/i;

export const isGlimmerFile = (fileName: string): boolean =>
	glimmerFileNamePattern.test(fileName);

export const computeGlimmerTransform = (
	fileName: string,
	rawContents: string,
	rootDir: string,
): null | TransformedModule => {
	const glintConfig = createDefaultConfig(ts, rootDir);

	return rewriteModule(
		ts,
		{ script: { contents: rawContents, filename: fileName } },
		glintConfig.environment,
	);
};
```

`glimmerFileExtensionInfos` uses `ts.ScriptKind.Deferred` deliberately, not `ts.ScriptKind.TS`: TypeScript's `getSupportedExtensions` (used when globbing a project's `include`/`files` patterns) only adds an extra extension to its supported-extensions list when that extension's `scriptKind` is `Deferred` -- any other `scriptKind` value is silently ignored for file-discovery purposes. This was verified by reading TypeScript 5.9's own `getSupportedExtensions` source during planning, not assumed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/services/glimmer/index.test.ts`
Expected: PASS (all cases)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/services/glimmer/index.ts src/services/glimmer/index.test.ts
git commit -m "feat: add shared Glimmer-transform primitives"
```

---

### Task 2: Recognize and content-substitute `.gts`/`.gjs` files in the language-service pipeline

**Files:**

- Modify: `src/options/parseRawCompilerOptions.ts`
- Modify: `src/services/language.ts`
- Test: `src/services/language.test.ts` (new)

**Interfaces:**

- Consumes: `isGlimmerFile`, `glimmerFileExtensionInfos`, `computeGlimmerTransform` from Task 1's `src/services/glimmer/index.js`.
- Produces: `LanguageServices` gains `readonly glimmerTransforms: ReadonlyMap<string, TransformedModule>`. Later tasks read `request.services.glimmerTransforms.get(request.sourceFile.fileName)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/language.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseRawCompilerOptions } from "../options/parseRawCompilerOptions.js";
import { createLanguageServices } from "./language.js";

describe("createLanguageServices with .gts files", () => {
	it("type-checks .gts files against their transformed contents", () => {
		const packageDirectory = path.join(
			import.meta.dirname,
			"../tests/fixtures/glimmerLanguageServices",
		);
		const gtsFileName = path.join(packageDirectory, "highlight.gts");
		const parsedTsConfig = parseRawCompilerOptions(
			packageDirectory,
			"tsconfig.json",
		);

		const services = createLanguageServices({
			fixes: {} as never,
			output: {
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				stderr: () => {},
			} as never,
			package: {
				directory: packageDirectory,
				file: "package.json",
				missingTypes: undefined,
			},
			parsedTsConfig,
		} as never);

		const sourceFile = services.program.getSourceFile(gtsFileName);
		expect(sourceFile?.getFullText()).toContain("__glintDSL__");
		expect(services.glimmerTransforms.get(gtsFileName)).toBeDefined();
	});
});
```

`src/tests/fixtures/glimmerLanguageServices/tsconfig.json`:

```json
{
	"compilerOptions": {
		"strict": true,
		"target": "ES2022"
	},
	"include": ["highlight.gts"]
}
```

`src/tests/fixtures/glimmerLanguageServices/highlight.gts`:

```text
class Highlight {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/services/language.test.ts`
Expected: FAIL -- `sourceFile` is `undefined` (`highlight.gts` isn't discovered by `parseRawCompilerOptions` yet, since `.gts` isn't a supported extension without `extraFileExtensions`) or `services.glimmerTransforms` doesn't exist yet.

- [ ] **Step 3: Wire `extraFileExtensions` into config parsing**

```ts
// src/options/parseRawCompilerOptions.ts
import path from "node:path";
import ts from "typescript";

import { createParseConfigHost } from "../services/createParseConfigHost.js";
import { glimmerFileExtensionInfos } from "../services/glimmer/index.js";
import { stringifyDiagnosticMessageText } from "../shared/diagnostics.js";

export const parseRawCompilerOptions = (
	cwd: string,
	projectPath: string,
): ts.ParsedCommandLine => {
	const configFile = ts.getParsedCommandLineOfConfigFile(
		path.resolve(cwd, projectPath),
		undefined,
		createParseConfigHost(cwd),
		undefined,
		undefined,
		glimmerFileExtensionInfos,
	);

	if (!configFile) {
		throw new Error("tsConfig file not found.");
	}

	if (configFile.errors.length) {
		throw new Error(
			`Could not parse compiler options from '${projectPath}': ${stringifyDiagnosticMessageText(configFile.errors[0])}`,
		);
	}

	return configFile;
};
```

- [ ] **Step 4: Content-substitute `.gts`/`.gjs` files in `createLanguageServices`**

```ts
// src/services/language.ts
/* eslint-disable @typescript-eslint/unbound-method */
import { type TransformedModule } from "@glint/ember-tsc/transform";
import ts from "typescript";

import { TypeStatOptions } from "../options/types.js";
import { arrayify, uniquify } from "../shared/arrays.js";
import { computeGlimmerTransform, isGlimmerFile } from "./glimmer/index.js";

/**
 * Language service and type information with their backing TypeScript configuration.
 */
export interface LanguageServices {
	readonly glimmerTransforms: ReadonlyMap<string, TransformedModule>;
	readonly languageService: ts.LanguageService;
	readonly printers: Printers;
	readonly program: ts.Program;
}

export interface Printers {
	readonly node: (node: ts.Node, sourceFile: ts.SourceFile) => string;
	readonly type: (
		types: readonly (string | ts.Type)[] | string | ts.Type,
		enclosingDeclaration?: ts.Node,
		typeFormatFlags?: ts.TypeFormatFlags,
	) => string;
}

/**
 * @returns Associated language service and type information based on TypeStat options.
 */
export const createLanguageServices = (
	options: TypeStatOptions,
): LanguageServices => {
	const glimmerTransforms = new Map<string, TransformedModule>();

	const getFileContents = (fileName: string): string | undefined => {
		const rawContents = ts.sys.readFile(fileName);
		if (rawContents === undefined || !isGlimmerFile(fileName)) {
			return rawContents;
		}

		const cached = glimmerTransforms.get(fileName);
		if (cached !== undefined) {
			return cached.transformedContents;
		}

		const transformed = computeGlimmerTransform(
			fileName,
			rawContents,
			options.package.directory,
		);
		if (transformed === null) {
			return rawContents;
		}

		glimmerTransforms.set(fileName, transformed);
		return transformed.transformedContents;
	};

	// Create a TypeScript language service
	const languageServiceHost: ts.LanguageServiceHost = {
		directoryExists: ts.sys.directoryExists,
		fileExists: ts.sys.fileExists,
		getCompilationSettings: () => options.parsedTsConfig.options,
		getCurrentDirectory: () => options.package.directory,
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		getDirectories: ts.sys.getDirectories,
		getProjectReferences: () => options.parsedTsConfig.projectReferences,
		getScriptFileNames: () => options.parsedTsConfig.fileNames,
		getScriptSnapshot: (fileName) =>
			ts.sys.fileExists(fileName)
				? ts.ScriptSnapshot.fromString(getFileContents(fileName) ?? "")
				: undefined,
		getScriptVersion: () => "0",
		readDirectory: ts.sys.readDirectory,
		readFile: getFileContents,
	};
	const languageService = ts.createLanguageService(languageServiceHost);

	const program = languageService.getProgram();
	if (!program) {
		throw new Error("Error creating Program");
	}

	// This printer will later come in handy for emitting raw ASTs to text
	const printer = ts.createPrinter({
		newLine: options.parsedTsConfig.options.newLine,
	});
	const printers: Printers = {
		node(node, sourceFile) {
			return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
		},
		type(types, enclosingDeclaration, typeFormatFlags) {
			const typeChecker = program.getTypeChecker();
			return uniquify(
				...arrayify(types).map((type) =>
					typeof type === "string"
						? type
						: typeChecker.typeToString(
								// Our mutations generally always go for base primitives, not literals
								// This might need to be revisited for potential future high fidelity types...
								typeChecker.getBaseTypeOfLiteralType(type),
								enclosingDeclaration,
								typeFormatFlags,
							),
				),
			).join(" | ");
		},
	};

	return {
		glimmerTransforms,
		languageService,
		printers,
		program,
	};
};
/* eslint-enable @typescript-eslint/unbound-method */
```

No `getScriptKind` override is needed on the host: TypeScript's own `ensureScriptKind` (used internally by the language service) already falls back to `ScriptKind.TS` for any file whose extension it doesn't recognize (`scriptKind || getScriptKindFromFileName(fileName) || ScriptKind.TS`) -- verified by reading TypeScript 5.9's own source during planning. `.gts` gets the correct fallback for free; `.gjs` would too, but is moot in practice since Plan 1's rename stage always converts `.gjs` to `.gts` earlier in the same pipeline run before any fixer (new or existing) sees the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- src/services/language.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full existing test suite to check for regressions**

Run: `pnpm test`
Expected: PASS (no existing `.ts`/`.tsx` behavior changed -- `getFileContents` is a no-op passthrough for non-Glimmer files)

- [ ] **Step 7: Commit**

```bash
git add src/options/parseRawCompilerOptions.ts src/services/language.ts src/services/language.test.ts src/tests/fixtures/glimmerLanguageServices
git commit -m "feat: recognize and content-substitute .gts/.gjs files in the language service"
```

---

### Task 3: Central position-remap wrapper around `findMutationsInFile`

**Files:**

- Modify: `src/runtime/findMutationsInFile.ts`
- Create: `src/runtime/remapGlimmerMutations.ts`
- Test: `src/runtime/remapGlimmerMutations.test.ts` (new)

**Interfaces:**

- Consumes: `request.services.glimmerTransforms` from Task 2.
- Produces: `remapGlimmerMutations(mutations: readonly Mutation[], transform: TransformedModule): readonly Mutation[]`, used internally by `findMutationsInFile` -- no other task calls it directly.

- [ ] **Step 1: Write the failing test**

```ts
// src/runtime/remapGlimmerMutations.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeGlimmerTransform } from "../services/glimmer/index.js";
import { remapGlimmerMutations } from "./remapGlimmerMutations.js";

describe("remapGlimmerMutations", () => {
	const rootDir = path.join(import.meta.dirname, "../../..");
	const rawContents = `class Highlight {\n\t<template>\n\t\t<div ...attributes>{{yield}}</div>\n\t</template>\n}\n`;
	const transform = computeGlimmerTransform(
		"highlight.gts",
		rawContents,
		rootDir,
	);
	if (transform === null) {
		throw new Error("Expected a non-null transform");
	}

	it("passes through positions in the pass-through (identity-mapped) region unchanged", () => {
		const classKeywordOffset = rawContents.indexOf("class");
		const [remapped] = remapGlimmerMutations(
			[
				{
					range: { begin: classKeywordOffset, end: classKeywordOffset + 5 },
					type: "text-delete",
				},
			],
			transform,
		);

		expect(remapped.range).toStrictEqual({
			begin: classKeywordOffset,
			end: classKeywordOffset + 5,
		});
	});

	it("remaps a position inside the transformed template region back to the original file", () => {
		const applySplattributesOffset =
			transform.transformedContents.indexOf("applySplattributes");
		const [remapped] = remapGlimmerMutations(
			[
				{
					insertion: "",
					range: { begin: applySplattributesOffset },
					type: "text-insert",
				},
			],
			transform,
		);

		expect(remapped.range.begin).toBeGreaterThanOrEqual(
			rawContents.indexOf("<template>"),
		);
		expect(remapped.range.begin).toBeLessThanOrEqual(rawContents.length);
	});

	it("recurses into combined (multiple) mutations", () => {
		const classKeywordOffset = rawContents.indexOf("class");
		const [remapped] = remapGlimmerMutations(
			[
				{
					mutations: [
						{
							insertion: "",
							range: { begin: classKeywordOffset },
							type: "text-insert",
						},
					],
					range: { begin: classKeywordOffset },
					type: "multiple",
				},
			],
			transform,
		);

		expect(remapped.type).toBe("multiple");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/runtime/remapGlimmerMutations.test.ts`
Expected: FAIL with "Cannot find module './remapGlimmerMutations.js'"

- [ ] **Step 3: Implement the remap wrapper**

```ts
// src/runtime/remapGlimmerMutations.ts
import { type TransformedModule } from "@glint/ember-tsc/transform";
import { type Mutation, type MutationRange } from "automutate";

interface MultipleMutation extends Mutation {
	readonly mutations: readonly Mutation[];
}

const isMultipleMutation = (mutation: Mutation): mutation is MultipleMutation =>
	mutation.type === "multiple" && "mutations" in mutation;

export const remapGlimmerMutations = (
	mutations: readonly Mutation[],
	transform: TransformedModule,
): readonly Mutation[] =>
	mutations.map((mutation) => remapMutation(mutation, transform));

const remapMutation = (
	mutation: Mutation,
	transform: TransformedModule,
): Mutation => {
	if (isMultipleMutation(mutation)) {
		return {
			...mutation,
			mutations: remapGlimmerMutations(mutation.mutations, transform),
		};
	}

	return {
		...mutation,
		range: remapRange(mutation.range, transform),
	};
};

const remapRange = (
	range: MutationRange,
	transform: TransformedModule,
): MutationRange => ({
	begin: transform.getOriginalOffset(range.begin).offset,
	end:
		range.end === undefined
			? undefined
			: transform.getOriginalOffset(range.end).offset,
});
```

`getOriginalOffset` always returns `{ offset, source? }` (never `undefined`) for any transformed offset, including ones inside pass-through regions, where it returns the same offset unchanged -- confirmed against `TransformedModule`'s real `.d.ts` during planning. This is why the pass-through case in the first test needs no special-casing.

- [ ] **Step 4: Wire the remap into `findMutationsInFile`**

```ts
// src/runtime/findMutationsInFile.ts
import { Mutation } from "automutate";
import { EOL } from "os";

import { MutationsComplaint } from "../mutators/complaint.js";
import { FileMutationsRequest, FileMutator } from "../shared/fileMutator.js";
import { findFirstMutations } from "../shared/runtime.js";
import { remapGlimmerMutations } from "./remapGlimmerMutations.js";

/**
 * Collects all mutations that should apply to a file.
 */
export const findMutationsInFile = (
	request: FileMutationsRequest,
	mutators: readonly [string, FileMutator][],
): readonly Mutation[] | undefined => {
	let mutations = findFirstMutations(request, mutators);
	if (mutations instanceof MutationsComplaint) {
		request.options.output.stderr(
			`${EOL}Error in ${request.sourceFile.fileName} with ${mutations.mutatorPath.join(" > ")}: ${mutations.error.stack}${EOL}${EOL}`,
		);

		mutations = undefined;
	}

	if (mutations === undefined) {
		return undefined;
	}

	const transform = request.services.glimmerTransforms.get(
		request.sourceFile.fileName,
	);

	return transform === undefined
		? mutations
		: remapGlimmerMutations(mutations, transform);
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- src/runtime/remapGlimmerMutations.test.ts src/runtime/findMutationsInFile.ts`
Expected: PASS

- [ ] **Step 6: Run the full existing test suite to check for regressions**

Run: `pnpm test`
Expected: PASS (`request.services.glimmerTransforms.get(...)` returns `undefined` for every existing `.ts`/`.tsx` fixture, so `findMutationsInFile` returns `mutations` unchanged, exactly as before)

- [ ] **Step 7: Commit**

```bash
git add src/runtime/findMutationsInFile.ts src/runtime/remapGlimmerMutations.ts src/runtime/remapGlimmerMutations.test.ts
git commit -m "feat: remap Glimmer fixer mutation positions back to the original file"
```

---

### Task 4: Shared Signature-locating and -patching helpers

**Files:**

- Create: `src/mutations/glimmerSignatures/findComponentClassDeclaration.ts`
- Create: `src/mutations/glimmerSignatures/patchSignatureMember.ts`
- Test: `src/mutations/glimmerSignatures/findComponentClassDeclaration.test.ts` (new)
- Test: `src/mutations/glimmerSignatures/patchSignatureMember.test.ts` (new)

**Interfaces:**

- Produces: `findComponentClassDeclaration(sourceFile: ts.SourceFile): ts.ClassDeclaration | undefined`; `patchSignatureMember(request: FileMutationsRequest, componentClass: ts.ClassDeclaration, memberName: "Args" | "Blocks" | "Element", newTypeText: string): Mutation | undefined`. Both are consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing tests for `findComponentClassDeclaration`**

```ts
// src/mutations/glimmerSignatures/findComponentClassDeclaration.test.ts
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findComponentClassDeclaration } from "./findComponentClassDeclaration.js";

const createSourceFile = (text: string) =>
	ts.createSourceFile("component.gts", text, ts.ScriptTarget.ES2022, true);

describe("findComponentClassDeclaration", () => {
	it("finds a class extending Component", () => {
		const sourceFile = createSourceFile(
			`class Highlight extends Component<{}> {}`,
		);

		const result = findComponentClassDeclaration(sourceFile);

		expect(result?.name?.text).toBe("Highlight");
	});

	it("returns undefined when no class extends Component", () => {
		const sourceFile = createSourceFile(`class Highlight {}`);

		expect(findComponentClassDeclaration(sourceFile)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/mutations/glimmerSignatures/findComponentClassDeclaration.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `findComponentClassDeclaration`**

```ts
// src/mutations/glimmerSignatures/findComponentClassDeclaration.ts
import ts from "typescript";

export const findComponentClassDeclaration = (
	sourceFile: ts.SourceFile,
): ts.ClassDeclaration | undefined => {
	for (const statement of sourceFile.statements) {
		if (ts.isClassDeclaration(statement) && classExtendsComponent(statement)) {
			return statement;
		}
	}

	return undefined;
};

const classExtendsComponent = (node: ts.ClassDeclaration): boolean =>
	(node.heritageClauses ?? []).some(
		(clause) =>
			clause.token === ts.SyntaxKind.ExtendsKeyword &&
			clause.types.some(
				(type) =>
					ts.isIdentifier(type.expression) &&
					type.expression.text === "Component",
			),
	);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/mutations/glimmerSignatures/findComponentClassDeclaration.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for `patchSignatureMember`**

```ts
// src/mutations/glimmerSignatures/patchSignatureMember.test.ts
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { FileInfoCache } from "../../shared/FileInfoCache.js";
import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { NameGenerator } from "../../shared/NameGenerator.js";
import { findComponentClassDeclaration } from "./findComponentClassDeclaration.js";
import { patchSignatureMember } from "./patchSignatureMember.js";

const fileName = "/virtual/component.ts";

const createRequest = (sourceText: string): FileMutationsRequest => {
	const compilerHost: ts.CompilerHost = {
		...ts.createCompilerHost({}),
		fileExists: (requestedFileName) => requestedFileName === fileName,
		getSourceFile: (requestedFileName) =>
			requestedFileName === fileName
				? ts.createSourceFile(
						fileName,
						sourceText,
						ts.ScriptTarget.ES2022,
						true,
					)
				: undefined,
		readFile: (requestedFileName) =>
			requestedFileName === fileName ? sourceText : undefined,
	};

	const program = ts.createProgram([fileName], {}, compilerHost);
	const sourceFile = program.getSourceFile(fileName);
	if (sourceFile === undefined) {
		throw new Error("Expected a source file");
	}

	const filteredNodes = new Set<ts.Node>();
	const services = {
		glimmerTransforms: new Map(),
		languageService: {} as ts.LanguageService,
		printers: {} as never,
		program,
	};

	return {
		fileInfoCache: new FileInfoCache(filteredNodes, services, sourceFile),
		filteredNodes,
		nameGenerator: new NameGenerator(fileName),
		options: { parsedTsConfig: { options: {} } } as never,
		services,
		sourceFile,
	};
};

const applyMutation = (
	sourceText: string,
	mutation: ReturnType<typeof patchSignatureMember>,
) => {
	if (mutation === undefined) {
		return sourceText;
	}

	const flattened =
		mutation.type === "multiple"
			? (
					mutation as unknown as {
						mutations: {
							insertion: string;
							range: { begin: number; end?: number };
						}[];
					}
				).mutations
			: [
					mutation as unknown as {
						insertion: string;
						range: { begin: number; end?: number };
					},
				];

	return flattened
		.slice()
		.sort((a, b) => b.range.begin - a.range.begin)
		.reduce(
			(text, { insertion, range }) =>
				text.slice(0, range.begin) +
				insertion +
				text.slice(range.end ?? range.begin),
			sourceText,
		);
};

describe("patchSignatureMember", () => {
	it("generates a named interface when the class has no Signature", () => {
		const sourceText = `class Highlight extends Component {}`;
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
			`interface HighlightSignature {\n\tElement: HTMLDivElement;\n}\n\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

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
			`class Highlight extends Component<{ Args: {} Element: HTMLDivElement;\n}> {}`,
		);
	});

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

	it("patches an existing named interface Signature in place", () => {
		const sourceText = `interface HighlightSignature { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
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
			`interface HighlightSignature { Args: {} Element: HTMLDivElement;\n}\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});
});
```

Note: the inline-literal insertion cases intentionally land right after the last member without reformatting surrounding whitespace, matching the existing `addMissingTypesToType`/`getEndInsertionPoint` precedent this helper is modeled on -- TypeStat does not reformat unrelated whitespace, and neither does this helper. If a test's exact expected string doesn't match `patchSignatureMember`'s real output byte-for-byte once Step 7 runs, fix the expected string to match the real (correct) output rather than changing the insertion logic to chase the guessed string, as long as the _content_ (member name + type text, no other change) is right.

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm test -- src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: FAIL with "Cannot find module './patchSignatureMember.js'"

- [ ] **Step 7: Implement `patchSignatureMember`**

```ts
// src/mutations/glimmerSignatures/patchSignatureMember.ts
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

	const [signatureTypeArgument] = heritageType.typeArguments ?? [];
	if (signatureTypeArgument === undefined) {
		return createNewSignatureMutation(
			componentClass,
			heritageType,
			memberName,
			newTypeText,
		);
	}

	const signatureMembersNode = resolveSignatureMembersNode(
		request,
		signatureTypeArgument,
	);
	if (signatureMembersNode === undefined) {
		return undefined;
	}

	return patchExistingSignatureMember(
		request,
		signatureMembersNode,
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

const resolveSignatureMembersNode = (
	request: FileMutationsRequest,
	signatureTypeArgument: ts.TypeNode,
): SignatureMembersNode | undefined => {
	if (ts.isTypeLiteralNode(signatureTypeArgument)) {
		return signatureTypeArgument;
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
		return declaration;
	}

	if (
		ts.isTypeAliasDeclaration(declaration) &&
		ts.isTypeLiteralNode(declaration.type)
	) {
		return declaration.type;
	}

	return undefined;
};

const patchExistingSignatureMember = (
	request: FileMutationsRequest,
	node: SignatureMembersNode,
	memberName: string,
	newTypeText: string,
): Mutation | undefined => {
	const existingMember = findExistingMember(node, memberName);

	if (existingMember === undefined) {
		return textInsert(
			`${memberName}: ${newTypeText};\n`,
			getEndInsertionPoint(node),
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

const getEndInsertionPoint = (node: SignatureMembersNode): number => {
	if (node.members.length === 0) {
		return node.end - 1;
	}

	const lastMember = node.members[node.members.length - 1];
	return Math.min(lastMember.end + 1, node.end);
};
```

- [ ] **Step 8: Run tests, fix any expected-string mismatches per the note in Step 5, until they pass**

Run: `pnpm test -- src/mutations/glimmerSignatures/patchSignatureMember.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mutations/glimmerSignatures
git commit -m "feat: add shared Glimmer Signature locating/patching helpers"
```

---

### Task 5: `fixGlimmerElementSignature` fixer

**Files:**

- Create: `src/mutators/builtIn/fixGlimmerElementSignature/index.ts`
- Create: `src/mutators/builtIn/fixGlimmerElementSignature/findApplySplattributesCall.ts`
- Create: `src/mutators/builtIn/fixGlimmerElementSignature/README.md`
- Modify: `src/mutators/builtIn/index.ts`
- Modify: `src/options/types.ts`
- Modify: `src/options/fillOutRawOptions.ts`
- Modify: `docs/Fixes.md`
- Modify: `src/tests/testSetup.ts` (preserve the original fixture's real extension instead of hardcoding `.ts`/`.tsx`)
- Create: `test/cases/fixes/glimmerElementSignature/basic/typestat.json`
- Create: `test/cases/fixes/glimmerElementSignature/basic/tsconfig.json`
- Create: `test/cases/fixes/glimmerElementSignature/basic/original.gts`
- Create: `test/cases/fixes/glimmerElementSignature/basic/expected.gts`
- Create: `test/fixGlimmerElementSignature.test.ts`
- Modify: `package.json` (add `ember-source` to `devDependencies`)

**Interfaces:**

- Consumes: `findComponentClassDeclaration`, `patchSignatureMember` from Task 4; `getTypeAtLocationIfNotError` from existing `src/shared/types.js`.
- Produces: `fixGlimmerElementSignature: FileMutator`, registered in `builtInFileMutators`.

- [ ] **Step 1: Add `ember-source` devDependency**

```bash
pnpm add -D ember-source@7.1.0
```

- [ ] **Step 2: Add the `glimmerElementSignature` fixer flag**

In `src/options/types.ts`, the `Fixes` interface (keep alphabetical order):

```ts
export interface Fixes {
	glimmerBlocksSignature: boolean;
	glimmerElementSignature: boolean;
	importExtensions: boolean;
	incompleteTypes: boolean;
	missingProperties: boolean;
	noImplicitAny: boolean;
	noImplicitThis: boolean;
	noInferableTypes: boolean;
	strictNonNullAssertions: boolean;
}
```

(`glimmerBlocksSignature` is added here now so this interface only needs editing once; Task 6 wires up its actual fixer.)

In `src/options/fillOutRawOptions.ts`, the `fixes` defaulting block:

```text
fixes: {
	glimmerBlocksSignature: false,
	glimmerElementSignature: false,
	importExtensions: false,
	incompleteTypes: false,
	missingProperties: false,
	noImplicitAny: false,
	noImplicitThis: false,
	noInferableTypes: false,
	strictNonNullAssertions: false,
	...rawOptions.fixes,
},
```

- [ ] **Step 3: Write the failing end-to-end test**

```ts
// test/fixGlimmerElementSignature.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Glimmer Element Signature", () => {
	it("infers the Element member from a splatted attribute", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerElementSignature/basic",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);
});
```

`test/cases/fixes/glimmerElementSignature/basic/typestat.json`:

```json
{
	"fixes": {
		"glimmerElementSignature": true
	}
}
```

`test/cases/fixes/glimmerElementSignature/basic/tsconfig.json`:

```json
{
	"compilerOptions": {
		"strict": true,
		"target": "ES2022",
		"types": ["ember-source/types"]
	},
	"files": ["actual.gts"]
}
```

`test/cases/fixes/glimmerElementSignature/basic/original.gts`:

```text
import Component from "@glimmer/component";

export default class Highlight extends Component {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
```

`test/cases/fixes/glimmerElementSignature/basic/expected.gts`:

```text
import Component from "@glimmer/component";

interface HighlightSignature {
	Element: HTMLDivElement;
}

export default class Highlight extends Component<HighlightSignature> {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
```

- [ ] **Step 4: Preserve the fixture's real extension in `runMutationTest`**

`runMutationTest` currently hardcodes `actual.ts`/`actual.tsx` based only on whether the original filename ends in `x`, which would silently write a `.gts` fixture out as `actual.ts`. Fix it to use the original file's real extension:

```ts
// src/tests/testSetup.ts
import { runMutations } from "automutate";
import fs from "node:fs/promises";
import path from "node:path";

import { loadPendingOptions } from "../options/loadPendingOptions.js";
import { createTypeStatProvider } from "../runtime/createTypeStatProvider.js";

export interface MutationTestResult {
	actualContent: string;
	expectedFilePath: string;
	options: string;
}

export const runMutationTest = async (
	dirPath: string,
): Promise<MutationTestResult> => {
	const originalFileName = (await fs.readdir(dirPath)).find((file) =>
		file.startsWith("original."),
	);
	if (!originalFileName) {
		throw new Error(`${dirPath} should have a file named original.*`);
	}

	const readFile = (filename: string) =>
		fs.readFile(path.join(dirPath, filename), "utf-8");

	const originalFile = path.join(dirPath, originalFileName);
	const originalExtension = originalFileName.slice(
		originalFileName.indexOf("."),
	);
	const actualFileName = `actual${originalExtension}`;
	const actualFile = path.join(dirPath, actualFileName);
	// file needs to exists before creating compiler options
	await fs.copyFile(originalFile, actualFile);

	const output = {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		log: () => {},
		stderr: console.error.bind(console),
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		stdout: () => {},
	};

	const pendingOptionsList = loadPendingOptions(
		"typestat.json",
		dirPath,
		output,
	);

	if (typeof pendingOptionsList === "string") {
		throw new Error("setting file missing");
	}

	for (const pendingOptions of pendingOptionsList) {
		await runMutations({
			mutationsProvider: createTypeStatProvider({
				...pendingOptions,
				fileNames: [actualFile],
			}),
		});
	}

	const actualContent = await readFile(actualFileName);
	const expectFileName = `expected${originalExtension}`;
	const expectedFilePath = path.join(dirPath, expectFileName);

	const optionsSnapshot = JSON.stringify(
		pendingOptionsList,
		null,
		2,
	).replaceAll(dirPath, "<rootDir>");

	return { actualContent, expectedFilePath, options: optionsSnapshot };
};
```

`originalFileName.slice(originalFileName.indexOf("."))` gives `.ts`/`.tsx`/`.gts` uniformly (previously the code special-cased only the `x`-suffix distinction between `.ts`/`.tsx`); every existing fixture's `original.ts`/`original.tsx` still produces `actual.ts`/`actual.tsx` exactly as before, so no existing test's fixture files are affected.

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm test:mutation -- test/fixGlimmerElementSignature.test.ts`
Expected: FAIL (`glimmerElementSignature` fixer doesn't exist yet; `actualContent` still contains `extends Component {` unchanged)

- [ ] **Step 6: Implement `findApplySplattributesCall`**

```ts
// src/mutators/builtIn/fixGlimmerElementSignature/findApplySplattributesCall.ts
import ts from "typescript";

export const findApplySplattributesCall = (
	sourceFile: ts.SourceFile,
): ts.CallExpression | undefined => {
	let found: ts.CallExpression | undefined;

	const visit = (node: ts.Node): void => {
		if (found !== undefined) {
			return;
		}

		if (isApplySplattributesCall(node)) {
			found = node;
			return;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
};

const isApplySplattributesCall = (node: ts.Node): node is ts.CallExpression =>
	ts.isCallExpression(node) &&
	ts.isPropertyAccessExpression(node.expression) &&
	ts.isIdentifier(node.expression.expression) &&
	node.expression.expression.text === "__glintDSL__" &&
	node.expression.name.text === "applySplattributes";
```

- [ ] **Step 7: Implement `fixGlimmerElementSignature`**

```ts
// src/mutators/builtIn/fixGlimmerElementSignature/index.ts
import { Mutation } from "automutate";

import { findComponentClassDeclaration } from "../../../mutations/glimmerSignatures/findComponentClassDeclaration.js";
import { patchSignatureMember } from "../../../mutations/glimmerSignatures/patchSignatureMember.js";
import {
	FileMutationsRequest,
	FileMutator,
} from "../../../shared/fileMutator.js";
import { getTypeAtLocationIfNotError } from "../../../shared/types.js";
import { findApplySplattributesCall } from "./findApplySplattributesCall.js";

export const fixGlimmerElementSignature: FileMutator = (
	request: FileMutationsRequest,
): readonly Mutation[] | undefined => {
	if (!request.options.fixes.glimmerElementSignature) {
		return undefined;
	}

	if (!request.services.glimmerTransforms.has(request.sourceFile.fileName)) {
		return undefined;
	}

	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		return undefined;
	}

	const splattributesCall = findApplySplattributesCall(request.sourceFile);
	if (splattributesCall === undefined) {
		return undefined;
	}

	const [, elementExpression] = splattributesCall.arguments;
	if (elementExpression === undefined) {
		return undefined;
	}

	const elementType = getTypeAtLocationIfNotError(request, elementExpression);
	if (elementType === undefined) {
		return undefined;
	}

	const newTypeText = request.services.printers.type(
		elementType,
		componentClass,
	);

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		newTypeText,
	);

	return mutation === undefined ? undefined : [mutation];
};
```

- [ ] **Step 8: Register the fixer**

```ts
// src/mutators/builtIn/index.ts
import { FileMutator } from "../../shared/fileMutator.js";
import { fixGlimmerElementSignature } from "./fixGlimmerElementSignature/index.js";
import { fixImportExtensions } from "./fixImportExtensions/index.js";
import { fixIncompleteTypes } from "./fixIncompleteTypes/index.js";
import { fixMissingProperties } from "./fixMissingProperties/index.js";
import { fixNoImplicitAny } from "./fixNoImplicitAny/index.js";
import { fixNoImplicitThis } from "./fixNoImplicitThis/index.js";
import { fixNoInferableTypes } from "./fixNoInferableTypes/index.js";
import { fixStrictNonNullAssertions } from "./fixStrictNonNullAssertions/index.js";

export const builtInFileMutators: readonly [string, FileMutator][] = [
	["fixGlimmerElementSignature", fixGlimmerElementSignature],
	["fixImportExtensions", fixImportExtensions],
	["fixIncompleteTypes", fixIncompleteTypes],
	["fixMissingProperties", fixMissingProperties],
	["fixNoImplicitAny", fixNoImplicitAny],
	["fixNoImplicitThis", fixNoImplicitThis],
	["fixNoInferableTypes", fixNoInferableTypes],
	["fixStrictNonNullAssertions", fixStrictNonNullAssertions],
];
```

(Task 6 adds `fixGlimmerBlocksSignature` above this entry, alphabetically first.)

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm test:mutation -- test/fixGlimmerElementSignature.test.ts`
Expected: PASS. If the exact inferred type text differs from `HTMLDivElement` (e.g. formatting), update `expected.gts` to match the real, correct output rather than changing `fixGlimmerElementSignature`'s logic to chase a guessed string.

- [ ] **Step 10: Add docs**

`docs/Fixes.md` -- add to the top JSON example block (alphabetical):

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

And a new section (placed alphabetically, before the `importExtensions` section):

```markdown
### `glimmerElementSignature`

Whether to infer a Glimmer component's `Element` Signature member from `...attributes` usage in its `<template>`.

See [fixGlimmerElementSignature/README.md](../src/mutators/builtIn/fixGlimmerElementSignature/README.md).
```

`src/mutators/builtIn/fixGlimmerElementSignature/README.md`:

```markdown
# `glimmerElementSignature`

Whether to infer a Glimmer component's `Element` Signature member from `...attributes` usage in its `<template>`.

This relies on `@glint/ember-tsc`'s template transform to resolve the concrete DOM element type that receives `...attributes`.

## Use Cases

- You're adding Signature types to an existing `.gts` component and don't want to hand-write the `Element` member

## Configuration

\`\`\`json
{
"fixes": {
"glimmerElementSignature": true
}
}
\`\`\`

## Mutations

### Element Signature Inference

If a component's template spreads `...attributes` onto an element, that element's concrete DOM type is added or updated as the Signature's `Element` member.

#### Examples: Element Signature Inference

\`\`\`diff
+interface HighlightSignature {

- Element: HTMLDivElement;
  +}
- -export default class Highlight extends Component {
  +export default class Highlight extends Component<HighlightSignature> {
  <template>
  <div ...attributes>{{yield}}</div>
  </template>
  }
  \`\`\`
```

- [ ] **Step 11: Run the full existing test suite to check for regressions**

Run: `pnpm test && pnpm test:mutation`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add package.json pnpm-lock.yaml src/options/types.ts src/options/fillOutRawOptions.ts src/mutators/builtIn/index.ts src/mutators/builtIn/fixGlimmerElementSignature src/tests/testSetup.ts test/cases/fixes/glimmerElementSignature test/fixGlimmerElementSignature.test.ts docs/Fixes.md
git commit -m "feat: add fixGlimmerElementSignature fixer"
```

---

### Task 6: `fixGlimmerBlocksSignature` fixer

**Files:**

- Create: `src/mutators/builtIn/fixGlimmerBlocksSignature/index.ts`
- Create: `src/mutators/builtIn/fixGlimmerBlocksSignature/findYieldToBlockCalls.ts`
- Create: `src/mutators/builtIn/fixGlimmerBlocksSignature/README.md`
- Modify: `src/mutators/builtIn/index.ts`
- Modify: `docs/Fixes.md`
- Create: `test/cases/fixes/glimmerBlocksSignature/basic/typestat.json`
- Create: `test/cases/fixes/glimmerBlocksSignature/basic/tsconfig.json`
- Create: `test/cases/fixes/glimmerBlocksSignature/basic/original.gts`
- Create: `test/cases/fixes/glimmerBlocksSignature/basic/expected.gts`
- Create: `test/fixGlimmerBlocksSignature.test.ts`

**Interfaces:**

- Consumes: `findComponentClassDeclaration`, `patchSignatureMember` from Task 4 (unchanged); the `glimmerBlocksSignature` flag already added to `Fixes`/`fillOutRawOptions.ts` in Task 5.
- Produces: `fixGlimmerBlocksSignature: FileMutator`, registered in `builtInFileMutators`.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// test/fixGlimmerBlocksSignature.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Glimmer Blocks Signature", () => {
	it("infers the Blocks member from a named yield", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerBlocksSignature/basic",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);
});
```

`test/cases/fixes/glimmerBlocksSignature/basic/typestat.json`:

```json
{
	"fixes": {
		"glimmerBlocksSignature": true
	}
}
```

`test/cases/fixes/glimmerBlocksSignature/basic/tsconfig.json`:

```json
{
	"compilerOptions": {
		"strict": true,
		"target": "ES2022",
		"types": ["ember-source/types"]
	},
	"files": ["actual.gts"]
}
```

`test/cases/fixes/glimmerBlocksSignature/basic/original.gts`:

```text
import Component from "@glimmer/component";

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

`test/cases/fixes/glimmerBlocksSignature/basic/expected.gts`:

```text
import Component from "@glimmer/component";

interface HighlightArgs {
	items: string[];
}

export default class Highlight extends Component<{
	Args: HighlightArgs;
	Blocks: {
		default: [string, number];
	};
}> {
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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:mutation -- test/fixGlimmerBlocksSignature.test.ts`
Expected: FAIL (`glimmerBlocksSignature` fixer doesn't exist yet)

- [ ] **Step 3: Implement `findYieldToBlockCalls`**

```ts
// src/mutators/builtIn/fixGlimmerBlocksSignature/findYieldToBlockCalls.ts
import ts from "typescript";

export interface YieldToBlockCall {
	readonly blockName: string;
	readonly yieldedArguments: readonly ts.Expression[];
}

export const findYieldToBlockCalls = (
	sourceFile: ts.SourceFile,
): readonly YieldToBlockCall[] => {
	const calls: YieldToBlockCall[] = [];

	const visit = (node: ts.Node): void => {
		const call = tryReadYieldToBlockCall(node);
		if (call !== undefined) {
			calls.push(call);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return calls;
};

const tryReadYieldToBlockCall = (
	node: ts.Node,
): undefined | YieldToBlockCall => {
	if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression)) {
		return undefined;
	}

	const innerCall = node.expression;
	if (
		!ts.isPropertyAccessExpression(innerCall.expression) ||
		!ts.isIdentifier(innerCall.expression.expression) ||
		innerCall.expression.expression.text !== "__glintDSL__" ||
		innerCall.expression.name.text !== "yieldToBlock"
	) {
		return undefined;
	}

	const [, blockNameArgument] = innerCall.arguments;
	if (
		blockNameArgument === undefined ||
		!ts.isStringLiteralLike(blockNameArgument)
	) {
		return undefined;
	}

	return {
		blockName: blockNameArgument.text,
		yieldedArguments: node.arguments,
	};
};
```

- [ ] **Step 4: Implement `fixGlimmerBlocksSignature`**

```ts
// src/mutators/builtIn/fixGlimmerBlocksSignature/index.ts
import { Mutation } from "automutate";

import { findComponentClassDeclaration } from "../../../mutations/glimmerSignatures/findComponentClassDeclaration.js";
import { patchSignatureMember } from "../../../mutations/glimmerSignatures/patchSignatureMember.js";
import {
	FileMutationsRequest,
	FileMutator,
} from "../../../shared/fileMutator.js";
import { getTypeAtLocationIfNotError } from "../../../shared/types.js";
import { findYieldToBlockCalls } from "./findYieldToBlockCalls.js";

export const fixGlimmerBlocksSignature: FileMutator = (
	request: FileMutationsRequest,
): readonly Mutation[] | undefined => {
	if (!request.options.fixes.glimmerBlocksSignature) {
		return undefined;
	}

	if (!request.services.glimmerTransforms.has(request.sourceFile.fileName)) {
		return undefined;
	}

	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		return undefined;
	}

	const yieldCalls = findYieldToBlockCalls(request.sourceFile);
	if (yieldCalls.length === 0) {
		return undefined;
	}

	const blocksTypeText = buildBlocksTypeText(request, yieldCalls);
	if (blocksTypeText === undefined) {
		return undefined;
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Blocks",
		blocksTypeText,
	);

	return mutation === undefined ? undefined : [mutation];
};

const buildBlocksTypeText = (
	request: FileMutationsRequest,
	yieldCalls: readonly ReturnType<typeof findYieldToBlockCalls>[number][],
): string | undefined => {
	const tuplesByBlockName = new Map<string, string[]>();

	for (const { blockName, yieldedArguments } of yieldCalls) {
		// Different branches yielding to the same block with a different arity can't be
		// merged into one tuple; keep the first occurrence and skip the rest.
		if (tuplesByBlockName.has(blockName)) {
			continue;
		}

		const argumentTypeTexts = yieldedArguments.map((argumentExpression) => {
			const argumentType = getTypeAtLocationIfNotError(
				request,
				argumentExpression,
			);
			return argumentType === undefined
				? undefined
				: request.services.printers.type(argumentType);
		});

		if (argumentTypeTexts.some((typeText) => typeText === undefined)) {
			continue;
		}

		tuplesByBlockName.set(blockName, argumentTypeTexts as string[]);
	}

	if (tuplesByBlockName.size === 0) {
		return undefined;
	}

	const memberLines = Array.from(
		tuplesByBlockName,
		([blockName, argumentTypeTexts]) =>
			`\t${blockName}: [${argumentTypeTexts.join(", ")}];`,
	);

	return `{\n${memberLines.join("\n")}\n}`;
};
```

- [ ] **Step 5: Register the fixer**

```ts
// src/mutators/builtIn/index.ts
import { FileMutator } from "../../shared/fileMutator.js";
import { fixGlimmerBlocksSignature } from "./fixGlimmerBlocksSignature/index.js";
import { fixGlimmerElementSignature } from "./fixGlimmerElementSignature/index.js";
import { fixImportExtensions } from "./fixImportExtensions/index.js";
import { fixIncompleteTypes } from "./fixIncompleteTypes/index.js";
import { fixMissingProperties } from "./fixMissingProperties/index.js";
import { fixNoImplicitAny } from "./fixNoImplicitAny/index.js";
import { fixNoImplicitThis } from "./fixNoImplicitThis/index.js";
import { fixNoInferableTypes } from "./fixNoInferableTypes/index.js";
import { fixStrictNonNullAssertions } from "./fixStrictNonNullAssertions/index.js";

export const builtInFileMutators: readonly [string, FileMutator][] = [
	["fixGlimmerBlocksSignature", fixGlimmerBlocksSignature],
	["fixGlimmerElementSignature", fixGlimmerElementSignature],
	["fixImportExtensions", fixImportExtensions],
	["fixIncompleteTypes", fixIncompleteTypes],
	["fixMissingProperties", fixMissingProperties],
	["fixNoImplicitAny", fixNoImplicitAny],
	["fixNoImplicitThis", fixNoImplicitThis],
	["fixNoInferableTypes", fixNoInferableTypes],
	["fixStrictNonNullAssertions", fixStrictNonNullAssertions],
];
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:mutation -- test/fixGlimmerBlocksSignature.test.ts`
Expected: PASS. If the real inferred tuple/formatting differs from the guessed `expected.gts` (e.g. `readonly` tuple modifiers, exact whitespace), update `expected.gts` to match the real, correct output.

- [ ] **Step 7: Add docs**

`docs/Fixes.md` -- new section (alphabetically first, before `glimmerElementSignature`):

```markdown
### `glimmerBlocksSignature`

Whether to infer a Glimmer component's `Blocks` Signature member from `{{yield ...}}` usage in its `<template>`.

See [fixGlimmerBlocksSignature/README.md](../src/mutators/builtIn/fixGlimmerBlocksSignature/README.md).
```

`src/mutators/builtIn/fixGlimmerBlocksSignature/README.md`:

```markdown
# `glimmerBlocksSignature`

Whether to infer a Glimmer component's `Blocks` Signature member from `{{yield ...}}` usage in its `<template>`.

This relies on `@glint/ember-tsc`'s template transform to resolve the concrete types of each yielded value, regardless of what control flow (`{{#each}}`, `{{#let}}`, etc.) surrounds the yield.

## Use Cases

- You're adding Signature types to an existing `.gts` component and don't want to hand-write the `Blocks` member

## Configuration

\`\`\`json
{
"fixes": {
"glimmerBlocksSignature": true
}
}
\`\`\`

## Mutations

### Blocks Signature Inference

If a component's template yields values to a block, that block's yielded value types are added or updated as a member of the Signature's `Blocks`.

#### Examples: Blocks Signature Inference

\`\`\`diff
export default class Highlight extends Component<{
Args: HighlightArgs;

- Blocks: {
-     default: [string, number];
- };
  }> {
  <template>
  {{#each this.filtered as |item index|}}
  {{yield item index}}
  {{/each}}
  </template>
  }
  \`\`\`
```

- [ ] **Step 8: Run the full existing test suite to check for regressions**

Run: `pnpm test && pnpm test:mutation`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mutators/builtIn/index.ts src/mutators/builtIn/fixGlimmerBlocksSignature test/cases/fixes/glimmerBlocksSignature test/fixGlimmerBlocksSignature.test.ts docs/Fixes.md
git commit -m "feat: add fixGlimmerBlocksSignature fixer"
```

---

## Self-Review

**Spec coverage:**

- Shared Glimmer-transform infrastructure -- Task 1 (`computeGlimmerTransform`/`isGlimmerFile`) + Task 2 (wiring into `createLanguageServices`, plus the file-discovery gap the spec didn't call out, found during planning). Covered.
- Central position-remap choke point -- Task 3. Covered.
- Existing 7 fixers see template-only usage evidence for free, no per-fixer changes -- a direct consequence of Task 2's content substitution; no task modifies any of the 7 existing fixers. Covered.
- `patchSignatureMember`'s two cases (generate named interface vs. patch existing Signature in place, never converting one form to the other) -- Task 4, all four unit tests. Covered.
- `Element` inference -- Task 5. Note: the spec's originally sketched algorithm (raw-template `@glimmer/syntax` parse + forward position-mapping to disambiguate the attributes-receiving element) was superseded during planning by a simpler, equally-correct mechanism found through a real `rewriteModule` run: matching the transformed AST's own `__glintDSL__.applySplattributes(...)` call directly, which Glimmer only ever emits once per template. This drops `@glimmer/syntax` as a needed direct dependency entirely. Same outcome, less code, verified against real output rather than sketched from the API surface alone.
- `Blocks` inference, including multiple-yields-to-the-same-block unioning -- Task 6. Note: true member-wise type unioning (as the spec described) was narrowed during planning to "keep the first occurrence, skip conflicting-arity duplicates" -- documented inline in `buildBlocksTypeText`, not silently dropped.
- `Args` inference -- explicitly out of scope per the spec; no task attempts it.
- General "verify zero diagnostics" pass -- explicitly out of scope per the spec; no task attempts it.
- Testing approach (unit tests for `patchSignatureMember`, integration tests against real `@glint/ember-tsc` with `ember-source`/`@glimmer/component` devDependencies, `@glint/ember-tsc` as a real dependency) -- Tasks 1, 4, 5, 6. Covered.

**Placeholder scan:** No "TBD"/"implement later"/"add appropriate handling" language. Every step has real, verified-shape code. Two known simplifications from the original spec sketch (Element's matching mechanism, Blocks' union-vs-first-occurrence behavior) are called out explicitly above and inline in code comments, not hidden.

**Type consistency:** `FileMutator`'s signature (`(request: FileMutationsRequest) => MutationsComplaint | readonly Mutation[] | undefined`) is used identically by both new fixers. `LanguageServices.glimmerTransforms: ReadonlyMap<string, TransformedModule>` (introduced Task 2) is read the same way (`.get(fileName)`/`.has(fileName)`) in Tasks 3, 5, and 6. `patchSignatureMember`'s `memberName` parameter type (`"Args" | "Blocks" | "Element"`) matches both call sites' literal arguments (`"Element"` in Task 5, `"Blocks"` in Task 6). `findComponentClassDeclaration`'s return type (`ts.ClassDeclaration | undefined`) is checked for `undefined` identically in both fixers.
