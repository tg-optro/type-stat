import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

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
		getCompilationSettings: () => ({ allowNonTsExtensions: true }),
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

	it("extracts an inline Signature literal missing a member into a named interface", () => {
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

		// Run this test once the implementation exists (Step 3) to see the real output,
		// then confirm the body text below matches -- the interface body is a direct
		// character-offset splice of the original literal's own text, so exact
		// whitespace depends on getEndInsertionPoint's existing (unchanged) logic.
		expect(applyMutation(sourceText, mutation)).toBe(
			`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\n\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

	it("extracts an inline Signature literal while replacing a differing member's type", () => {
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
			`interface HighlightSignature { Element: HTMLDivElement }\n\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

	it("still extracts an inline Signature literal even when the member's type already matches", () => {
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

		expect(applyMutation(sourceText, mutation)).toBe(
			`interface HighlightSignature { Element: HTMLDivElement }\n\nclass Highlight extends Component<HighlightSignature> {}`,
		);
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

	it("does not mutate an already-correctly-named interface whose member already matches", () => {
		const sourceText = `interface HighlightSignature { Element: HTMLDivElement }\nclass Highlight extends Component<HighlightSignature> {}`;
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

	it("renames a differently-named existing interface and every same-file reference", () => {
		const sourceText = `interface ListSignature { Args: {} }\nfunction describe(args: ListSignature): string { return String(args); }\nclass Highlight extends Component<ListSignature> {}`;
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
			`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nfunction describe(args: HighlightSignature): string { return String(args); }\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

	it("converts a same-named type alias to an interface", () => {
		const sourceText = `type HighlightSignature = { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
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

	it("converts a differently-named type alias to an interface and renames references", () => {
		const sourceText = `type ListSignature = { Args: {} }\nfunction describe(args: ListSignature): string { return String(args); }\nclass Highlight extends Component<ListSignature> {}`;
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
			`interface HighlightSignature { Args: {};\n\tElement: HTMLDivElement;\n }\nfunction describe(args: HighlightSignature): string { return String(args); }\nclass Highlight extends Component<HighlightSignature> {}`,
		);
	});

	it("emits a warning when converting a type alias to an interface", () => {
		const sourceText = `type HighlightSignature = { Args: {} }\nclass Highlight extends Component<HighlightSignature> {}`;
		const request = createRequest(sourceText);
		const stdout = vi.fn();
		(request.options.output as unknown as { stdout: typeof stdout }).stdout =
			stdout;
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		patchSignatureMember(request, componentClass, "Element", "HTMLDivElement");

		expect(stdout).toHaveBeenCalledOnce();
	});

	it("emits a warning when extracting an inline literal into an interface", () => {
		const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
		const request = createRequest(sourceText);
		const stdout = vi.fn();
		(request.options.output as unknown as { stdout: typeof stdout }).stdout =
			stdout;
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		patchSignatureMember(request, componentClass, "Element", "HTMLDivElement");

		expect(stdout).toHaveBeenCalledOnce();
	});

	it("throws when the target Signature name collides with an unrelated declaration", () => {
		const sourceText = `interface ListSignature { Args: {} }\ninterface HighlightSignature { Blocks: {} }\nclass Highlight extends Component<ListSignature> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		expect(() =>
			patchSignatureMember(
				request,
				componentClass,
				"Element",
				"HTMLDivElement",
			),
		).toThrow(/HighlightSignature/);
	});

	it("throws when a .gjs file unexpectedly has an existing Signature type argument", () => {
		const sourceText = `class Highlight extends Component<{ Args: {} }> {}`;
		const request = createRequest(sourceText, "/virtual/component.gjs");
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		expect(() =>
			patchSignatureMember(
				request,
				componentClass,
				"Element",
				"HTMLDivElement",
			),
		).toThrow(/\.gjs/);
	});

	it("throws when the existing Signature type argument can't be resolved into an object shape", () => {
		const sourceText = `type Combined = { Args: {} } | { Blocks: {} };\nclass Highlight extends Component<Combined> {}`;
		const request = createRequest(sourceText);
		const componentClass = findComponentClassDeclaration(request.sourceFile);
		if (componentClass === undefined) {
			throw new Error("Expected a component class");
		}

		expect(() =>
			patchSignatureMember(
				request,
				componentClass,
				"Element",
				"HTMLDivElement",
			),
		).toThrow(/Could not resolve/);
	});
});
