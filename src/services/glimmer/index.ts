import { createDefaultConfig } from "@glint/ember-tsc";
import {
	rewriteModule,
	type TransformedModule,
} from "@glint/ember-tsc/transform";
import ts from "typescript";

export const glimmerFileExtensionInfos: readonly ts.FileExtensionInfo[] = [
	{
		extension: ".gts",
		isMixedContent: false,
		scriptKind: ts.ScriptKind.Deferred,
	},
	{
		extension: ".gjs",
		isMixedContent: false,
		scriptKind: ts.ScriptKind.Deferred,
	},
];

const glimmerFileNamePattern = /\.g(?:js|ts)$/i;

export const isGlimmerFile = (fileName: string): boolean =>
	glimmerFileNamePattern.test(fileName);

export const computeGlimmerTransform = (
	fileName: string,
	rawContents: string,
	rootDir: string,
): null | TransformedModule => {
	const glintConfig = createDefaultConfig(ts, rootDir);

	return rewriteModule(
		ts,
		{ script: { contents: rawContents, filename: fileName } },
		glintConfig.environment,
	);
};
