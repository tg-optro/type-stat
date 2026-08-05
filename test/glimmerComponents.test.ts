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
	// eslint-disable-next-line vitest/no-disabled-tests -- intentional, see above
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

	it("adds a missing property declaration in a .gts class alongside a template", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/missingProperty",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	// Skipped: typing a Glimmer component's constructor (owner: Owner, args:
	// <ComponentName>Signature['Args']) is future work, not implemented by any
	// current fixer -- see the "Explicitly out of scope" section of
	// docs/superpowers/specs/2026-08-03-glimmer-signature-inference-design.md
	// (Args inference). expected.gts pre-encodes the aspirational target so
	// this can be un-skipped once that work lands.
	// eslint-disable-next-line vitest/no-disabled-tests -- intentional, see above
	it.skip("types a component's constructor from its Signature's Args member", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerComponents/constructorArgs",
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
