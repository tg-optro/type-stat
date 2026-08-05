import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
	findNodeByStartingPosition,
	narrowToInnermostNodeAtSameStart,
} from "./nodes.js";

const createSourceFile = (sourceText: string) =>
	ts.createSourceFile(
		"/virtual/component.ts",
		sourceText,
		ts.ScriptTarget.Latest,
		true,
	);

describe("findNodeByStartingPosition", () => {
	it("returns the outermost node when an ancestor shares the exact same start position", () => {
		// `Foo`'s Identifier, its enclosing TypeReferenceNode, and the outer
		// IndexedAccessTypeNode all start at the exact same offset -- the position
		// right before "Foo". Several existing callers (e.g. fixIncompleteParameterTypes,
		// which needs the enclosing ExpressionStatement of a call site rather than
		// just the callee identifier) depend on getting the *outermost* such node
		// back, so this behavior is intentionally preserved.
		const sourceFile = createSourceFile(`type X = Foo["bar"];\n`);

		const start = sourceFile.text.indexOf("Foo");
		const node = findNodeByStartingPosition(sourceFile, start);

		expect(node).toBeDefined();
		expect(node !== undefined && ts.isIndexedAccessTypeNode(node)).toBe(true);
	});

	it("returns a wrapping declaration rather than descending into its name", () => {
		// `value`'s VariableDeclaration and its name Identifier also share a start
		// position (there's no `const` token inside the declaration itself), and
		// callers such as fixIncompleteImplicitGenerics rely on getting the
		// VariableDeclaration back, not the bare Identifier.
		const sourceFile = createSourceFile(`const value = 1;\n`);

		const start = sourceFile.text.indexOf("value");
		const node = findNodeByStartingPosition(sourceFile, start);

		expect(node).toBeDefined();
		expect(node !== undefined && ts.isVariableDeclaration(node)).toBe(true);
	});
});

describe("narrowToInnermostNodeAtSameStart", () => {
	it("narrows an IndexedAccessTypeNode down to its leftmost Identifier", () => {
		// This is exactly the case that broke Signature-interface renaming: naively
		// reusing the node `findNodeByStartingPosition` returns for a reference to
		// `Foo` inside `Foo["bar"]` -- the whole IndexedAccessTypeNode -- and
		// swapping its full text range corrupts the rename by also overwriting
		// `["bar"]`. Narrowing to the innermost node first avoids that.
		const sourceFile = createSourceFile(`type X = Foo["bar"];\n`);

		const start = sourceFile.text.indexOf("Foo");
		const outerNode = findNodeByStartingPosition(sourceFile, start);
		if (outerNode === undefined) {
			throw new Error("Expected a node at the given position");
		}

		const innermostNode = narrowToInnermostNodeAtSameStart(
			sourceFile,
			outerNode,
		);

		expect(ts.isIdentifier(innermostNode)).toBe(true);
		expect((innermostNode as ts.Identifier).text).toBe("Foo");
		expect(innermostNode.getStart(sourceFile)).toBe(start);
		expect(innermostNode.end).toBe(start + "Foo".length);
	});

	it("is idempotent once it reaches an already-innermost node", () => {
		const sourceFile = createSourceFile(`type X = Foo["bar"];\n`);

		const start = sourceFile.text.indexOf("Foo");
		const outerNode = findNodeByStartingPosition(sourceFile, start);
		if (outerNode === undefined) {
			throw new Error("Expected a node at the given position");
		}

		const innermostNode = narrowToInnermostNodeAtSameStart(
			sourceFile,
			outerNode,
		);
		const renarrowedNode = narrowToInnermostNodeAtSameStart(
			sourceFile,
			innermostNode,
		);

		expect(renarrowedNode).toBe(innermostNode);
	});
});
