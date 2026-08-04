import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Generic classes (existing fixers, no regression)", () => {
	// Skipped: fixNoImplicitAny never fixes class property declarations (checks
	// TS error code 7005, but properties emit 7008) -- see
	// docs/dev/2026-08-03-no-implicit-any-property-declarations-bug.md.
	// expected.ts already encodes the correct target (count: number) so this
	// can just be un-skipped once that bug is fixed.
	it.skip("infers an instance field's type from usage evidence", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/class/instanceField",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	// This isn't a TypeStat gap so much as a TypeScript one: no fixer here
	// adds a return type from scratch (fixIncompleteReturnTypes only widens
	// an *existing* annotation), and more fundamentally, TypeScript's own
	// language service offers zero code fixes for the TS7023 diagnostic this
	// getter triggers (verified directly via getCodeFixesAtPosition against
	// this exact fixture -- it returns []). There's no suggested fix for
	// TypeStat to relay, so "untouched" is the correct, permanent expectation
	// here, not a bug to pre-encode a future fix for.
	it("leaves a circularly-typed instance getter untouched", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/class/instanceGetter",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("infers an instance method's parameter type from call-site usage", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/class/instanceMethod",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("infers a constructor's parameter type from call-site usage", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/class/constructor",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);
});
