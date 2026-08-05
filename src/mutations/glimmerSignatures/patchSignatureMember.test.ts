import ts from "typescript";
import { describe, expect, it } from "vitest";

import { FileInfoCache } from "../../shared/FileInfoCache.js";
import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { NameGenerator } from "../../shared/NameGenerator.js";
import { findComponentClassDeclaration } from "./findComponentClassDeclaration.js";
import { patchSignatureMember } from "./patchSignatureMember.js";

const fileName = "/virtual/component.ts";

const createRequest = (
	sourceText: string,
	requestFileName: string = fileName,
): FileMutationsRequest => {
	const files = new Map([[requestFileName, sourceText]]);

	const languageServiceHost: ts.LanguageServiceHost = {
		fileExists: (requestedFileName) => files.has(requestedFileName),
		getCompilationSettings: () => ({}),
		getCurrentDirectory: () => "/virtual",
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		getScriptFileNames: () => [requestFileName],
		getScriptSnapshot: (requestedFileName) => {
			const contents = files.get(requestedFileName);
			return contents === undefined
				? undefined
				: ts.ScriptSnapshot.fromString(contents);
		},
		getScriptVersion: () => "0",
		readFile: (requestedFileName) => files.get(requestedFileName),
	};

	const languageService = ts.createLanguageService(
		languageServiceHost,
		ts.createDocumentRegistry(),
	);
	const program = languageService.getProgram();
	if (program === undefined) {
		throw new Error("Expected a program");
	}

	const sourceFile = program.getSourceFile(requestFileName);
	if (sourceFile === undefined) {
		throw new Error("Expected a source file");
	}

	const filteredNodes = new Set<ts.Node>();
	const services = {
		glimmerTransforms: new Map(),
		languageService,
		printers: {} as never,
		program,
	};

	return {
		fileInfoCache: new FileInfoCache(filteredNodes, services, sourceFile),
		filteredNodes,
		nameGenerator: new NameGenerator(requestFileName),
		options: {
			output: {
				// eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
				stderr: () => {},
				// eslint-disable-next-line @typescript-eslint/no-empty-function -- test stub
				stdout: () => {},
			},
			parsedTsConfig: { options: {} },
		} as never,
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
