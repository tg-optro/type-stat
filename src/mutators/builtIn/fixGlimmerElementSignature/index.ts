import { Mutation } from "automutate";

import { findComponentClassDeclaration } from "../../../mutations/glimmerSignatures/findComponentClassDeclaration.js";
import { patchSignatureMember } from "../../../mutations/glimmerSignatures/patchSignatureMember.js";
import {
	FileMutationsRequest,
	FileMutator,
} from "../../../shared/fileMutator.js";
import { getTypeAtLocationIfNotError } from "../../../shared/types.js";
import { findApplySplattributesCall } from "./findApplySplattributesCall.js";

export const fixGlimmerElementSignature: FileMutator = (
	request: FileMutationsRequest,
): readonly Mutation[] | undefined => {
	if (!request.options.fixes.glimmerElementSignature) {
		return undefined;
	}

	if (!request.services.glimmerTransforms.has(request.sourceFile.fileName)) {
		return undefined;
	}

	const componentClass = findComponentClassDeclaration(request.sourceFile);
	if (componentClass === undefined) {
		return undefined;
	}

	const splattributesCall = findApplySplattributesCall(request.sourceFile);
	if (splattributesCall === undefined) {
		return undefined;
	}

	const [, elementExpression] = splattributesCall.arguments;
	const elementType = getTypeAtLocationIfNotError(request, elementExpression);
	if (elementType === undefined) {
		return undefined;
	}

	const newTypeText = request.services.printers.type(
		elementType,
		componentClass,
	);

	const mutation = patchSignatureMember(
		request,
		componentClass,
		"Element",
		newTypeText,
	);

	return mutation === undefined ? undefined : [mutation];
};
