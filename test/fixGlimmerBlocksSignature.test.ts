import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Glimmer Blocks Signature", () => {
	it("infers the Blocks member from a named yield", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerBlocksSignature/multipleValues",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

	it("infers a Blocks member per named block, alongside the default block", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerBlocksSignature/namedBlocks",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);

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
});
