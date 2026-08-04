import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findComponentClassDeclaration } from "./findComponentClassDeclaration.js";

const createSourceFile = (text: string) =>
	ts.createSourceFile("component.gts", text, ts.ScriptTarget.ES2022, true);

describe("findComponentClassDeclaration", () => {
	it("finds a class extending Component", () => {
		const sourceFile = createSourceFile(
			`class Highlight extends Component<{}> {}`,
		);

		const result = findComponentClassDeclaration(sourceFile);

		expect(result?.name?.text).toBe("Highlight");
	});

	it("returns undefined when no class extends Component", () => {
		const sourceFile = createSourceFile(`class Highlight {}`);

		expect(findComponentClassDeclaration(sourceFile)).toBeUndefined();
	});
});
