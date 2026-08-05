# `.gjs` -> `.gts` Rename Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach TypeStat's file-renaming stage to recognize `.gjs` files and rename them to `.gts` (analogous to its existing `.js`/`.jsx` -> `.ts`/`.tsx` support), unconditionally -- regardless of the `files.renameExtensions` setting's `"ts"`/`"tsx"` forced-extension values, since a Glimmer-template-carrying file can only ever become `.gts`.

**Architecture:** This is subsystem 1 of 3 in the full `.gjs`/`.gts` migration effort (see `docs/dev/2026-08-03-glimmer-plugin-discovery.md`). It only touches the existing `createFileRenamesProvider` stage -- extending the extension-detection regex and the new-extension logic -- with no dependency on `@glint/ember-tsc` or any Glimmer-aware type inference (that's subsystems 2/3, planned separately). This subsystem is fully independent and ships working, testable behavior on its own.

**Tech Stack:** TypeScript, Vitest (existing repo conventions).

## Global Constraints

- Must not change behavior for existing `.js`/`.jsx`/`.mjs`/`.cjs` inputs -- `getNewFileName.test.ts`'s existing cases are the regression baseline and must keep passing unmodified.
- Follow repo conventions: tabs for indentation (per `.prettierrc.json`), Vitest (`describe`/`it`/`expect`/`vi` from `"vitest"`), ESM imports with explicit `.js` extensions (per existing files in this directory).
- No new dependencies -- this subsystem does not touch `@glint/ember-tsc` or any Glimmer parsing.
- No comments explaining _what_ code does; only add a comment where the _why_ is non-obvious (here: why `.gjs` ignores the forced `"ts"`/`"tsx"` setting).

---

## File Structure

- **Modify:** `src/runtime/providers/createFileRenamesProvider/getNewFileName.ts` -- add a `.gjs` -> `.gts` branch, checked before the existing `renameExtensions` string/auto-detect branches.
- **Modify:** `src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts` -- add regression cases proving `.gjs` always becomes `.gts`.
- **Modify:** `src/runtime/providers/createFileRenamesProvider/index.ts` -- extend `javaScriptExtensionMatcher` to also match `.gjs`, and export the previously-private `fileNameIsJavaScript` so it's directly testable.
- **Create:** `src/runtime/providers/createFileRenamesProvider/index.test.ts` -- new test file (none exists today) covering `fileNameIsJavaScript`, including regression cases for `.ts`/`.gts`/`.tsx` correctly returning `false`.
- **Modify:** `docs/Files.md` -- document `.gjs`/`.gts` under the existing `renameExtensions` section.

---

### Task 1: `getNewFileName` maps `.gjs` to `.gts` unconditionally

**Files:**

- Modify: `src/runtime/providers/createFileRenamesProvider/getNewFileName.ts`
- Test: `src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts`

**Interfaces:**

- Consumes: existing `RenameExtensions` type (`"ts" | "tsx" | boolean`) from `../../../options/types.js` -- no change.
- Produces: `getNewFileName(renameExtensions, oldFileName, readFile): Promise<string>` -- same signature as before; Task 2 does not depend on any change here beyond this file's own behavior.

- [ ] **Step 1: Write the failing tests**

Add to `src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts`, inside the existing `describe("getNewFileName", ...)` block (after the existing `it.each` for JSX-sniffing):

```ts
it.each([
	{ renameExtensions: true as const },
	{ renameExtensions: "ts" as const },
	{ renameExtensions: "tsx" as const },
])(
	"returns a .gts path when the old file is .gjs and renameExtensions is $renameExtensions",
	async ({ renameExtensions }) => {
		const actual = await getNewFileName(
			renameExtensions,
			"path/name.gjs",
			vi.fn(),
		);

		expect(actual).toBe("path/name.gts");
	},
);

it("does not read file contents when the old file is .gjs", async () => {
	const readFile = vi.fn();

	await getNewFileName(true, "path/name.gjs", readFile);

	expect(readFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts`
Expected: FAIL -- the three `.gts` cases currently return `path/name.ts` (renameExtensions `"ts"`), `path/name.tsx` (`"tsx"`), or fall through to the JSX-sniffing branch and call `readFile` (`true`), so the "does not read file contents" case also fails.

- [ ] **Step 3: Write the minimal implementation**

Replace the full contents of `src/runtime/providers/createFileRenamesProvider/getNewFileName.ts` with:

```ts
import { RenameExtensions } from "../../../options/types.js";

export const getNewFileName = async (
	renameExtensions: RenameExtensions,
	oldFileName: string,
	readFile: (filePath: string) => Promise<string>,
): Promise<string> => {
	const oldExtension = oldFileName.substring(oldFileName.lastIndexOf("."));
	const beforeExtension = oldFileName.substring(
		0,
		oldFileName.length - oldExtension.length,
	);

	// .gjs carries a Glimmer <template> tag, so it can only ever become .gts --
	// forcing it to plain .ts/.tsx per a "ts"/"tsx" setting would silently
	// strip its ability to contain templates.
	if (oldExtension.toLowerCase() === ".gjs") {
		return `${beforeExtension}.gts`;
	}

	if (typeof renameExtensions === "string") {
		return `${beforeExtension}.${renameExtensions}`;
	}

	const fileContents = await readFile(oldFileName);
	const fileContentsJoined = fileContents.replace(/ /g, "").replace(/"/g, "'");

	// eslint-disable-next-line regexp/no-obscure-range
	if (/<\s*\/\s*(?:[A-z.]+\s*)?>|\/\s*>/.test(fileContentsJoined)) {
		return `${beforeExtension}.tsx`;
	}

	return `${beforeExtension}.ts`;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts`
Expected: PASS -- all existing cases plus the three new `.gjs` cases and the "does not read file contents" case.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/providers/createFileRenamesProvider/getNewFileName.ts src/runtime/providers/createFileRenamesProvider/getNewFileName.test.ts
git commit -m "feat: map .gjs files to .gts in getNewFileName"
```

---

### Task 2: Recognize `.gjs` as a renamable JavaScript file

**Files:**

- Modify: `src/runtime/providers/createFileRenamesProvider/index.ts`
- Create: `src/runtime/providers/createFileRenamesProvider/index.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `fileNameIsJavaScript(fileName: string): boolean`, now exported from `index.ts` (previously an unexported local `const`). No other exported symbol in this file changes shape (`createFileRenamesProvider` keeps its existing signature).

- [ ] **Step 1: Write the failing test**

Create `src/runtime/providers/createFileRenamesProvider/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { fileNameIsJavaScript } from "./index.js";

describe("fileNameIsJavaScript", () => {
	it.each([
		{ expected: true, fileName: "a.js" },
		{ expected: true, fileName: "a.jsx" },
		{ expected: true, fileName: "a.cjs" },
		{ expected: true, fileName: "a.mjs" },
		{ expected: true, fileName: "a.gjs" },
		{ expected: false, fileName: "a.ts" },
		{ expected: false, fileName: "a.tsx" },
		{ expected: false, fileName: "a.gts" },
		{ expected: false, fileName: "a.json" },
	])("returns $expected for $fileName", ({ expected, fileName }) => {
		expect(fileNameIsJavaScript(fileName)).toBe(expected);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/runtime/providers/createFileRenamesProvider/index.test.ts`
Expected: FAIL with a module resolution/type error -- `fileNameIsJavaScript` is not exported from `./index.js` yet, and the `a.gjs` case would return `false` even if it were.

- [ ] **Step 3: Write the minimal implementation**

In `src/runtime/providers/createFileRenamesProvider/index.ts`, change:

```ts
const javaScriptExtensionMatcher = /\.(?:c|m)?jsx?/i;

const fileNameIsJavaScript = (fileName: string) =>
	javaScriptExtensionMatcher.test(fileName);
```

to:

```ts
const javaScriptExtensionMatcher = /\.(?:c|m|g)?jsx?/i;

export const fileNameIsJavaScript = (fileName: string) =>
	javaScriptExtensionMatcher.test(fileName);
```

(No other lines in this file change -- `fileNameIsJavaScript` is already used exactly as before within this same file, just now also exported.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/runtime/providers/createFileRenamesProvider/index.test.ts`
Expected: PASS -- all nine cases, including the `.gts` regression case correctly returning `false` (confirms the new `g` alternative doesn't also match `.gts`, since the pattern requires `js`/`jsx` after the optional `c|m|g` prefix, not `ts`).

Also run the full existing suite to confirm no regressions from the shared regex change:

Run: `pnpm vitest run src/runtime/providers/createFileRenamesProvider`
Expected: PASS -- both test files in this directory.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/providers/createFileRenamesProvider/index.ts src/runtime/providers/createFileRenamesProvider/index.test.ts
git commit -m "feat: recognize .gjs as a renamable JavaScript file"
```

---

### Task 3: Document `.gjs`/`.gts` support

**Files:**

- Modify: `docs/Files.md`

**Interfaces:**

- None -- documentation only.

- [ ] **Step 1: Update the docs**

In `docs/Files.md`, under the `## \`renameExtensions\``section's "Mapping Extensions" list, add a new bullet after the`"tsx"` bullet's example block (before the "When auto-detection is enabled..." paragraph):

```markdown
`.gjs` files are always renamed to `.gts`, regardless of which of the above
four settings is active -- a Glimmer-template-carrying file can only ever
have a `.gts` counterpart, since plain `.ts`/`.tsx` cannot contain a
`<template>` tag.
```

- [ ] **Step 2: Commit**

```bash
git add docs/Files.md
git commit -m "docs: document .gjs to .gts rename behavior"
```

---

## Self-Review

**Spec coverage:**

- ".gjs files renamed to .gts" -- Task 1 (unconditional mapping) + Task 2 (detection regex). Covered.
- "regardless of renameExtensions forced-extension settings" -- Task 1's three parametrized cases (`true`, `"ts"`, `"tsx"`). Covered.
- "no regression to existing .js/.jsx/.mjs/.cjs handling" -- Task 2's regression cases (`a.js`, `a.jsx`, `a.cjs`, `a.mjs` all still `true`; `a.ts`/`a.tsx`/`a.gts` still `false`) plus running the full existing `getNewFileName.test.ts` suite unmodified in Task 1. Covered.
- Documentation -- Task 3. Covered.

**Placeholder scan:** No "TBD"/"implement later"/"add appropriate handling" language present; every step has concrete, complete code.

**Type consistency:** `getNewFileName`'s signature is unchanged across both tasks (`(renameExtensions: RenameExtensions, oldFileName: string, readFile: (filePath: string) => Promise<string>) => Promise<string>`). `fileNameIsJavaScript`'s signature (`(fileName: string) => boolean`) is introduced and used identically in Task 2's own test; no other task references it yet (subsystems 2/3 may reuse it later, out of scope here).
