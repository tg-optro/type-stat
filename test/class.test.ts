import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Generic classes (existing fixers, no regression)", () => {
	it("leaves an untyped instance field untouched (see bug report)", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/class/instanceField",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("leaves a self-referential instance getter untouched", async () => {
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
