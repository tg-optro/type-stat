import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeGlimmerTransform, isGlimmerFile } from "./index.js";

describe("isGlimmerFile", () => {
	it.each([
		["component.gts", true],
		["component.gjs", true],
		["Component.GTS", true],
		["component.ts", false],
		["component.tsx", false],
		["component.js", false],
	])("%s -> %s", (fileName, expected) => {
		expect(isGlimmerFile(fileName)).toBe(expected);
	});
});

describe("computeGlimmerTransform", () => {
	const rootDir = path.join(import.meta.dirname, "../../..");

	it("transforms a .gts component's <template> into type-checkable TypeScript", () => {
		const rawContents = `
class Highlight {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
`;

		const transformed = computeGlimmerTransform(
			"highlight.gts",
			rawContents,
			rootDir,
		);

		expect(transformed).not.toBeNull();
		expect(transformed?.transformedContents).toContain("__glintDSL__");
		expect(transformed?.transformedContents).toContain("applySplattributes");
		expect(transformed?.transformedContents).toContain("yieldToBlock");
	});

	it("returns a TransformedModule with errors for malformed template syntax, not null", () => {
		const transformed = computeGlimmerTransform(
			"broken.gts",
			"<template>{{#each}}</template>",
			rootDir,
		);

		expect(transformed).not.toBeNull();
		expect(transformed?.errors.length).toBeGreaterThan(0);
	});

	it("returns null when there is no template to transform", () => {
		const transformed = computeGlimmerTransform(
			"empty.gts",
			"export const x = 1;",
			rootDir,
		);

		expect(transformed).toBeNull();
	});
});
