/* eslint-disable @typescript-eslint/unbound-method */
import { type TransformedModule } from "@glint/ember-tsc/transform";
import ts from "typescript";

import { TypeStatOptions } from "../options/types.js";
import { arrayify, uniquify } from "../shared/arrays.js";
import { computeGlimmerTransform, isGlimmerFile } from "./glimmer/index.js";

/**
 * Language service and type information with their backing TypeScript configuration.
 */
export interface LanguageServices {
	readonly glimmerTransforms: ReadonlyMap<string, TransformedModule>;
	readonly languageService: ts.LanguageService;
	readonly printers: Printers;
	readonly program: ts.Program;
}

export interface Printers {
	readonly node: (node: ts.Node, sourceFile: ts.SourceFile) => string;
	readonly type: (
		types: readonly (string | ts.Type)[] | string | ts.Type,
		enclosingDeclaration?: ts.Node,
		typeFormatFlags?: ts.TypeFormatFlags,
	) => string;
}

/**
 * @returns Associated language service and type information based on TypeStat options.
 */
export const createLanguageServices = (
	options: TypeStatOptions,
): LanguageServices => {
	const glimmerTransforms = new Map<string, TransformedModule>();

	const getFileContents = (fileName: string): string | undefined => {
		const rawContents = ts.sys.readFile(fileName);
		if (rawContents === undefined || !isGlimmerFile(fileName)) {
			return rawContents;
		}

		const cached = glimmerTransforms.get(fileName);
		if (cached !== undefined) {
			return cached.transformedContents;
		}

		const transformed = computeGlimmerTransform(
			fileName,
			rawContents,
			options.package.directory,
		);
		if (transformed === null) {
			return rawContents;
		}

		glimmerTransforms.set(fileName, transformed);
		return transformed.transformedContents;
	};

	// TypeScript's Program rejects root files whose extension it doesn't recognize
	// (.gts, .gjs) before scriptKind is ever consulted, unless allowNonTsExtensions is
	// set -- the same thing tsserver itself sets automatically once extraFileExtensions
	// declares a Deferred script kind (see ts's hasDeferredExtension/allowNonTsExtensions).
	const compilationSettings: ts.CompilerOptions = {
		...options.parsedTsConfig.options,
		allowNonTsExtensions: true,
	};

	// Create a TypeScript language service
	const languageServiceHost: ts.LanguageServiceHost = {
		directoryExists: ts.sys.directoryExists,
		fileExists: ts.sys.fileExists,
		getCompilationSettings: () => compilationSettings,
		getCurrentDirectory: () => options.package.directory,
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		getDirectories: ts.sys.getDirectories,
		getProjectReferences: () => options.parsedTsConfig.projectReferences,
		getScriptFileNames: () => options.parsedTsConfig.fileNames,
		getScriptSnapshot: (fileName) =>
			ts.sys.fileExists(fileName)
				? ts.ScriptSnapshot.fromString(getFileContents(fileName) ?? "")
				: undefined,
		getScriptVersion: () => "0",
		readDirectory: ts.sys.readDirectory,
		readFile: getFileContents,
	};
	const languageService = ts.createLanguageService(languageServiceHost);

	const program = languageService.getProgram();
	if (!program) {
		throw new Error("Error creating Program");
	}

	// This printer will later come in handy for emitting raw ASTs to text
	const printer = ts.createPrinter({
		newLine: options.parsedTsConfig.options.newLine,
	});
	const printers: Printers = {
		node(node, sourceFile) {
			return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
		},
		type(types, enclosingDeclaration, typeFormatFlags) {
			const typeChecker = program.getTypeChecker();
			return uniquify(
				...arrayify(types).map((type) =>
					typeof type === "string"
						? type
						: typeChecker.typeToString(
								// Our mutations generally always go for base primitives, not literals
								// This might need to be revisited for potential future high fidelity types...
								typeChecker.getBaseTypeOfLiteralType(type),
								enclosingDeclaration,
								typeFormatFlags,
							),
				),
			).join(" | ");
		},
	};

	return {
		glimmerTransforms,
		languageService,
		printers,
		program,
	};
};
/* eslint-enable @typescript-eslint/unbound-method */
