import { describe, expect, it } from "vitest";

import { parseRawCompilerOptions } from "../../../options/parseRawCompilerOptions.js";
import { TypeStatOptions } from "../../../options/types.js";
import { createLanguageServices } from "../../../services/language.js";
import { collectReferencedPackageNames } from "./collectReferencedPackageNames.js";

describe("collectReferencedPackageNames", () => {
	it("should return package names", () => {
		const cwd = process.cwd();
		const parsedTsConfig = parseRawCompilerOptions(cwd, "tsconfig.json");
		const options: Partial<TypeStatOptions> = {
			package: {
				directory: process.cwd(),
				file: "package.json",
				missingTypes: true,
			},
			parsedTsConfig,
			projectPath: "tsconfig.json",
		};
		const services = createLanguageServices(options as TypeStatOptions);

		const packageNames = collectReferencedPackageNames(
			services,
			new Set<string>(),
		);

		// "assertion-error" is a real transitive type reference (vitest -> @vitest/expect
		// -> @types/chai -> assertion-error) that only became visible once
		// createLanguageServices's LanguageServiceHost gained a `realpath` implementation;
		// previously TypeScript couldn't see through pnpm's symlinked node_modules layout
		// to resolve it, so it was silently missing from this set.
		expect(Array.from(packageNames)).toStrictEqual([
			"node",
			"assertion-error",
			"automutate",
		]);
	}, 7_000);

	it("should ignore defined package names", () => {
		const cwd = process.cwd();
		const parsedTsConfig = parseRawCompilerOptions(cwd, "tsconfig.json");
		const options: Partial<TypeStatOptions> = {
			package: {
				directory: process.cwd(),
				file: "package.json",
				missingTypes: true,
			},
			parsedTsConfig,
			projectPath: "tsconfig.json",
		};
		const services = createLanguageServices(options as TypeStatOptions);

		const packageNames = collectReferencedPackageNames(
			services,
			new Set<string>(["automutate"]),
		);

		// See the comment above: "assertion-error" is genuinely referenced and is not
		// in the ignored set here, so (unlike "automutate") it still surfaces.
		expect(Array.from(packageNames)).toStrictEqual(["node", "assertion-error"]);
	});
});
