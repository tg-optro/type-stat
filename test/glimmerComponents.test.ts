import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Glimmer components (existing fixers, no regression)", () => {
	it("leaves a getter passed as an arg to a nested component untouched", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/nested",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	// Skipped: fixNoImplicitAny never fixes class property declarations (checks
	// TS error code 7005, but properties emit 7008) -- see
	// docs/dev/2026-08-03-no-implicit-any-property-declarations-bug.md.
	// expected.gts already encodes the correct target (@tracked count: number)
	// so this can just be un-skipped once that bug is fixed.
	it.skip("infers a @tracked property's type from usage evidence", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/tracked",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("adds a missing property declaration in a .gjs class alongside a template", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/missingProperty",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("leaves a template-only component (no backing class) untouched", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/templateOnly",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);
});
