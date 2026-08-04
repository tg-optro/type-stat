import { Mutation } from "automutate";
import ts from "typescript";

import { findComponentClassDeclaration } from "../../../mutations/glimmerSignatures/findComponentClassDeclaration.js";
import { patchSignatureMember } from "../../../mutations/glimmerSignatures/patchSignatureMember.js";
import {
	FileMutationsRequest,
	FileMutator,
} from "../../../shared/fileMutator.js";
import { getTypeAtLocationIfNotError } from "../../../shared/types.js";
import {
	findYieldToBlockCalls,
	YieldToBlockCall,
} from "./findYieldToBlockCalls.js";

export const fixGlimmerBlocksSignature: FileMutator = (
	request: FileMutationsRequest,
): readonly Mutation[] | undefined => {
	if (!request.options.fixes.glimmerBlocksSignature) {
		return undefined;
	}

	if (!request.services.glimmerTransforms.has(request.sourceFile.fileName)) {
		return undefined;
	}

	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		return undefined;
	}

	const yieldCalls = findYieldToBlockCalls(request.sourceFile);
	if (yieldCalls.length === 0) {
		return undefined;
	}

	const blocksTypeText = buildBlocksTypeText(request, yieldCalls);
	if (blocksTypeText === undefined) {
		return undefined;
	}

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Blocks",
		blocksTypeText,
	);

	return mutation === undefined ? undefined : [mutation];
};

const buildBlocksTypeText = (
	request: FileMutationsRequest,
	yieldCalls: readonly YieldToBlockCall[],
): string | undefined => {
	const tuplesByBlockName = new Map<string, string[]>();

	for (const { blockName, yieldedArguments } of yieldCalls) {
		// Different branches yielding to the same block with a different arity can't be
		// merged into one tuple; keep the first occurrence and skip the rest.
		if (tuplesByBlockName.has(blockName)) {
			continue;
		}

		const argumentTypeTexts = readArgumentTypeTexts(request, yieldedArguments);
		if (argumentTypeTexts === undefined) {
			continue;
		}

		tuplesByBlockName.set(blockName, argumentTypeTexts);
	}

	if (tuplesByBlockName.size === 0) {
		return undefined;
	}

	const memberLines = Array.from(
		tuplesByBlockName,
		([blockName, argumentTypeTexts]) =>
			`\t${blockName}: [${argumentTypeTexts.join(", ")}];`,
	);

	return `{\n${memberLines.join("\n")}\n}`;
};

const readArgumentTypeTexts = (
	request: FileMutationsRequest,
	yieldedArguments: readonly ts.Expression[],
): string[] | undefined => {
	const argumentTypeTexts: string[] = [];

	for (const argumentExpression of yieldedArguments) {
		const argumentType = getTypeAtLocationIfNotError(
			request,
			argumentExpression,
		);
		if (argumentType === undefined) {
			return undefined;
		}

		argumentTypeTexts.push(request.services.printers.type(argumentType));
	}

	return argumentTypeTexts;
};
