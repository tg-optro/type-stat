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
