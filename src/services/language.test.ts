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
