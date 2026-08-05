import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMutationTest } from "../src/tests/testSetup.js";

describe("Glimmer Args Signature", () => {
	// Skipped: typing a Glimmer component's constructor (owner: Owner, args:
	// <ComponentName>Signature['Args']) is future work -- no fixer implements
	// Args inference or constructor typing yet. See the "Explicitly out of
	// scope" section of
	// docs/superpowers/specs/2026-08-03-glimmer-signature-inference-design.md
	// and the spike at docs/dev/2026-08-05-glimmer-args-signature-spike.md.
	// expected.gts pre-encodes the aspirational target so this can be
	// un-skipped once that work lands.
	// eslint-disable-next-line vitest/no-disabled-tests -- intentional, see above
	it.skip("types a component's constructor from its Signature's Args member", async () => {
		const caseDir = path.join(
			import.meta.dirname,
			"./cases/fixes/glimmerArgsSignature/constructorArgs",
		);
		const { actualContent, expectedFilePath, options } =
			await runMutationTest(caseDir);
		await expect(actualContent).toMatchFileSnapshot(expectedFilePath);
		expect(options).toMatchSnapshot("options");
	}, 10000);
});
