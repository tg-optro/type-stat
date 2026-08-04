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
