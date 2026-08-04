import { combineMutations, Mutation } from "automutate";
import ts from "typescript";

import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { getStaticNameOfProperty } from "../../shared/names.js";
import {
	isNodeWithType,
	PropertySignatureWithType,
} from "../../shared/nodeTypes.js";
import { textInsert, textSwap } from "../text-mutations.js";

export type SignatureMembersNode = ts.InterfaceDeclaration | ts.TypeLiteralNode;

export const patchSignatureMember = (
	request: FileMutationsRequest,
	componentClass: ts.ClassDeclaration,
	memberName: "Args" | "Blocks" | "Element",
	newTypeText: string,
): Mutation | undefined => {
	const heritageType = findExtendsType(componentClass);
	if (heritageType === undefined) {
		return undefined;
	}

	if (
		heritageType.typeArguments === undefined ||
		heritageType.typeArguments.length === 0
	) {
		return createNewSignatureMutation(
			componentClass,
			heritageType,
			memberName,
			newTypeText,
		);
	}

	const [signatureTypeArgument] = heritageType.typeArguments;
	const signatureMembersNode = resolveSignatureMembersNode(
		request,
		signatureTypeArgument,
	);
	if (signatureMembersNode === undefined) {
		return undefined;
	}

	return patchExistingSignatureMember(
		request,
		signatureMembersNode,
		memberName,
		newTypeText,
	);
};

const findExtendsType = (
	componentClass: ts.ClassDeclaration,
): ts.ExpressionWithTypeArguments | undefined => {
	for (const heritageClause of componentClass.heritageClauses ?? []) {
		if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
			return heritageClause.types[0];
		}
	}

	return undefined;
};

const createNewSignatureMutation = (
	componentClass: ts.ClassDeclaration,
	heritageType: ts.ExpressionWithTypeArguments,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const componentName = componentClass.name?.text ?? "Component";
	const signatureName = `${componentName}Signature`;

	const newInterfaceInsertion = textInsert(
		`interface ${signatureName} {\n\t${memberName}: ${newTypeText};\n}\n\n`,
		componentClass.getStart(),
	);
	const newTypeArgumentInsertion = textInsert(
		`<${signatureName}>`,
		heritageType.expression.end,
	);

	return combineMutations(newInterfaceInsertion, newTypeArgumentInsertion);
};

const resolveSignatureMembersNode = (
	request: FileMutationsRequest,
	signatureTypeArgument: ts.TypeNode,
): SignatureMembersNode | undefined => {
	if (ts.isTypeLiteralNode(signatureTypeArgument)) {
		return signatureTypeArgument;
	}

	if (!ts.isTypeReferenceNode(signatureTypeArgument)) {
		return undefined;
	}

	const typeChecker = request.services.program.getTypeChecker();
	const symbol = typeChecker.getSymbolAtLocation(
		signatureTypeArgument.typeName,
	);
	const declaration = symbol?.declarations?.[0];

	if (declaration === undefined) {
		return undefined;
	}

	if (ts.isInterfaceDeclaration(declaration)) {
		return declaration;
	}

	if (
		ts.isTypeAliasDeclaration(declaration) &&
		ts.isTypeLiteralNode(declaration.type)
	) {
		return declaration.type;
	}

	return undefined;
};

const patchExistingSignatureMember = (
	request: FileMutationsRequest,
	node: SignatureMembersNode,
	memberName: string,
	newTypeText: string,
): Mutation | undefined => {
	const existingMember = findExistingMember(node, memberName);

	if (existingMember === undefined) {
		return textInsert(
			`${memberName}: ${newTypeText};\n`,
			getEndInsertionPoint(node),
		);
	}

	const existingTypeText = request.sourceFile.text.slice(
		existingMember.type.getStart(request.sourceFile),
		existingMember.type.end,
	);
	if (existingTypeText === newTypeText) {
		return undefined;
	}

	return textSwap(
		newTypeText,
		existingMember.type.getStart(request.sourceFile),
		existingMember.type.end,
	);
};

const findExistingMember = (
	node: SignatureMembersNode,
	memberName: string,
): PropertySignatureWithType | undefined => {
	for (const member of node.members) {
		if (!ts.isPropertySignature(member) || !isNodeWithType(member)) {
			continue;
		}

		if (getStaticNameOfProperty(member.name) === memberName) {
			return member;
		}
	}

	return undefined;
};

const getEndInsertionPoint = (node: SignatureMembersNode): number => {
	if (node.members.length === 0) {
		return node.end - 1;
	}

	const lastMember = node.members[node.members.length - 1];
	return Math.min(lastMember.end + 1, node.end);
};
