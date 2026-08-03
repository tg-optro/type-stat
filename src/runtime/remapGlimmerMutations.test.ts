import { type Mutations, type TextInsertMutation } from "automutate";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeGlimmerTransform } from "../services/glimmer/index.js";
import { remapGlimmerMutations } from "./remapGlimmerMutations.js";

describe("remapGlimmerMutations", () => {
	const rootDir = path.join(import.meta.dirname, "../../..");
	const rawContents = `class Highlight {\n\t<template>\n\t\t<div ...attributes>{{yield}}</div>\n\t</template>\n}\n`;
	const transform = computeGlimmerTransform(
		"highlight.gts",
		rawContents,
		rootDir,
	);
	if (transform === null) {
		throw new Error("Expected a non-null transform");
	}

	it("passes through positions in the pass-through (identity-mapped) region unchanged", () => {
		const classKeywordOffset = rawContents.indexOf("class");
		const [remapped] = remapGlimmerMutations(
			[
				{
					range: { begin: classKeywordOffset, end: classKeywordOffset + 5 },
					type: "text-delete",
				},
			],
			transform,
		);

		expect(remapped.range).toStrictEqual({
			begin: classKeywordOffset,
			end: classKeywordOffset + 5,
		});
	});

	it("remaps a position inside the transformed template region back to the original file", () => {
		const applySplattributesOffset =
			transform.transformedContents.indexOf("applySplattributes");
		const mutation: TextInsertMutation = {
			insertion: "",
			range: { begin: applySplattributesOffset },
			type: "text-insert",
		};
		const [remapped] = remapGlimmerMutations([mutation], transform);

		expect(remapped.range.begin).toBeGreaterThanOrEqual(
			rawContents.indexOf("<template>"),
		);
		expect(remapped.range.begin).toBeLessThanOrEqual(rawContents.length);
	});

	it("recurses into combined (multiple) mutations", () => {
		const classKeywordOffset = rawContents.indexOf("class");
		const innerMutation: TextInsertMutation = {
			insertion: "",
			range: { begin: classKeywordOffset },
			type: "text-insert",
		};
		const multipleMutation: Mutations = {
			mutations: [innerMutation],
			range: { begin: classKeywordOffset },
			type: "multiple",
		};
		const [remapped] = remapGlimmerMutations([multipleMutation], transform);

		expect(remapped.type).toBe("multiple");
	});
});
