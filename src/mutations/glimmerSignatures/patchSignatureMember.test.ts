import ts from "typescript";
import { describe, expect, it } from "vitest";

import { FileInfoCache } from "../../shared/FileInfoCache.js";
import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { NameGenerator } from "../../shared/NameGenerator.js";
import { findComponentClassDeclaration } from "./findComponentClassDeclaration.js";
import { patchSignatureMember } from "./patchSignatureMember.js";

const fileName = "/virtual/component.ts";

const createRequest = (sourceText: string): FileMutationsRequest => {
	const compilerHost: ts.CompilerHost = {
		...ts.createCompilerHost({}),
		fileExists: (requestedFileName) => requestedFileName === fileName,
		getSourceFile: (requestedFileName) =>
			requestedFileName === fileName
				? ts.createSourceFile(
						fileName,
						sourceText,
						ts.ScriptTarget.ES2022,
						true,
					)
				: undefined,
		readFile: (requestedFileName) =>
			requestedFileName === fileName ? sourceText : undefined,
	};

	const program = ts.createProgram([fileName], {}, compilerHost);
	const sourceFile = program.getSourceFile(fileName);
	if (sourceFile === undefined) {
		throw new Error("Expected a source file");
	}

	const filteredNodes = new Set<ts.Node>();
	const services = {
		glimmerTransforms: new Map(),
		languageService: {} as ts.LanguageService,
		printers: {} as never,
		program,
	};

	return {
		fileInfoCache: new FileInfoCache(filteredNodes, services, sourceFile),
		filteredNodes,
		nameGenerator: new NameGenerator(fileName),
		options: { parsedTsConfig: { options: {} } } as never,
		services,
		sourceFile,
	};
};

const applyMutation = (
	sourceText: string,
	mutation: ReturnType<typeof patchSignatureMember>,
) => {
	if (mutation === undefined) {
		return sourceText;
	}

	const flattened =
		mutation.type === "multiple"
			? (
					mutation as unknown as {
						mutations: {
							insertion: string;
							range: { begin: number; end?: number };
						}[];
					}
				).mutations
			: [
					mutation as unknown as {
						insertion: string;
						range: { begin: number; end?: number };
					},
				];

	return flattened
		.slice()
		.sort((a, b) => b.range.begin - a.range.begin)
		.reduce(
			(text, { insertion, range }) =>
				text.slice(0, range.begin) +
				insertion +
				text.slice(range.end ?? range.begin),
			sourceText,
		);
};

describe("patchSignatureMember", () => {
	it("generates a named interface when the class has no Signature", () => {
		const sourceText = `class Highlight extends Component {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		const mutation = patchSignatureMember(
			request,
			componentClass,
			"Element",
			"HTMLDivElement",
		);

		expect(applyMutation(sourceText, mutation)).toBe(
			`interface HighlightSignature {\n\tElement: HTMLDivElement;\n}\n\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

	it("adds a missing member to an existing inline Signature literal", () => {
		const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		const mutation = patchSignatureMember(
			request,
			componentClass,
			"Element",
			"HTMLDivElement",
		);

		expect(applyMutation(sourceText, mutation)).toBe(
			`class Highlight extends Component<{ Args: {};\n\tElement: HTMLDivElement;\n }> {}`,
		);
	});

	it("replaces a differing existing member's type in an inline Signature literal", () => {
		const sourceText = `class Highlight extends Component<{ Element: HTMLSpanElement }> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		const mutation = patchSignatureMember(
			request,
			componentClass,
			"Element",
			"HTMLDivElement",
		);

		expect(applyMutation(sourceText, mutation)).toBe(
			`class Highlight extends Component<{ Element: HTMLDivElement }> {}`,
		);
	});

	it("does not mutate when the existing member's type already matches", () => {
		const sourceText = `class Highlight extends Component<{ Element: HTMLDivElement }> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		const mutation = patchSignatureMember(
			request,
			componentClass,
			"Element",
			"HTMLDivElement",
		);

		expect(mutation).toBeUndefined();
	});

	it("patches an existing named interface Signature in place", () => {
		const sourceText = `interface HighlightSignature { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		const mutation = patchSignatureMember(
			request,
			componentClass,
			"Element",
			"HTMLDivElement",
		);

		expect(applyMutation(sourceText, mutation)).toBe(
			`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});
});
