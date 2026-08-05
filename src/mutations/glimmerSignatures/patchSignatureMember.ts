import { combineMutations, Mutation } from "automutate";
import ts from "typescript";

import { FileMutationsRequest } from "../../shared/fileMutator.js";
import { getStaticNameOfProperty } from "../../shared/names.js";
import { narrowToInnermostNodeAtSameStart } from "../../shared/nodes.js";
import {
	isNodeWithType,
	PropertySignatureWithType,
} from "../../shared/nodeTypes.js";
import { textInsert, textSwap } from "../text-mutations.js";

export type SignatureMembersNode = ts.InterfaceDeclaration | ts.TypeLiteralNode;

type ExistingSignatureSource =
	| {
			readonly declaration: ts.InterfaceDeclaration;
			readonly kind: "interface";
	  }
	| {
			readonly declaration: ts.TypeAliasDeclaration;
			readonly kind: "typeAlias";
	  }
	| { readonly kind: "inlineLiteral"; readonly literal: ts.TypeLiteralNode };

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

	ensureNotGlimmerJsFileWithExistingSignature(request.sourceFile);

	const [signatureTypeArgument] = heritageType.typeArguments;
	const source = resolveExistingSignatureSource(request, signatureTypeArgument);
	if (source === undefined) {
		throw new Error(
			`Could not resolve the existing Signature type argument on '${componentClass.name?.text ?? "the component"}' in '${request.sourceFile.fileName}' into a plain object shape (interface, type alias of an object literal, or inline literal). Refusing to guess how to normalize it.`,
		);
	}

	const componentName = componentClass.name?.text ?? "Component";
	const targetName = `${componentName}Signature`;

	if (source.kind === "interface") {
		if (source.declaration.name.text === targetName) {
			return patchExistingSignatureMember(
				request,
				source.declaration,
				memberName,
				newTypeText,
			);
		}

		ensureNoNameCollision(request.sourceFile, targetName, undefined);
		return renameSignatureDeclaration(
			request,
			source.declaration,
			targetName,
			memberName,
			newTypeText,
		);
	}

	if (source.kind === "typeAlias") {
		ensureNoNameCollision(request.sourceFile, targetName, source.declaration);
		warnAboutSignatureConversion(
			request,
			`type alias '${source.declaration.name.text}'`,
			targetName,
		);
		return convertTypeAliasAndPatch(
			request,
			source.declaration,
			targetName,
			memberName,
			newTypeText,
		);
	}

	ensureNoNameCollision(request.sourceFile, targetName, undefined);
	warnAboutSignatureConversion(request, "an inline literal", targetName);
	return extractInlineLiteralAndPatch(
		request,
		componentClass,
		source.literal,
		targetName,
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

const resolveExistingSignatureSource = (
	request: FileMutationsRequest,
	signatureTypeArgument: ts.TypeNode,
): ExistingSignatureSource | undefined => {
	if (ts.isTypeLiteralNode(signatureTypeArgument)) {
		return { kind: "inlineLiteral", literal: signatureTypeArgument };
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
		return { declaration, kind: "interface" };
	}

	if (
		ts.isTypeAliasDeclaration(declaration) &&
		ts.isTypeLiteralNode(declaration.type)
	) {
		return { declaration, kind: "typeAlias" };
	}

	return undefined;
};

const renameSignatureDeclaration = (
	request: FileMutationsRequest,
	declaration: ts.InterfaceDeclaration,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const declarationNameSwap = textSwap(
		targetName,
		declaration.name.getStart(request.sourceFile),
		declaration.name.end,
	);
	const referenceMutations = createReferenceRenameMutations(
		request,
		declaration.name,
		targetName,
	);
	const memberMutation = patchExistingSignatureMember(
		request,
		declaration,
		memberName,
		newTypeText,
	);

	const mutations: Mutation[] = [declarationNameSwap, ...referenceMutations];
	if (memberMutation !== undefined) {
		mutations.push(memberMutation);
	}

	return combineMutations(...mutations);
};

const convertTypeAliasAndPatch = (
	request: FileMutationsRequest,
	declaration: ts.TypeAliasDeclaration,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const literal = declaration.type as ts.TypeLiteralNode;

	const keywordSwap = textSwap(
		`interface ${targetName} `,
		declaration.getStart(request.sourceFile),
		literal.getStart(request.sourceFile),
	);
	const referenceMutations =
		declaration.name.text === targetName
			? []
			: createReferenceRenameMutations(request, declaration.name, targetName);
	const memberMutation = patchExistingSignatureMember(
		request,
		literal,
		memberName,
		newTypeText,
	);

	const mutations: Mutation[] = [keywordSwap, ...referenceMutations];
	if (memberMutation !== undefined) {
		mutations.push(memberMutation);
	}

	return combineMutations(...mutations);
};

const extractInlineLiteralAndPatch = (
	request: FileMutationsRequest,
	componentClass: ts.ClassDeclaration,
	literal: ts.TypeLiteralNode,
	targetName: string,
	memberName: string,
	newTypeText: string,
): Mutation => {
	const bodyText = buildSignatureBodyText(
		request,
		literal,
		memberName,
		newTypeText,
	);

	const newInterfaceInsertion = textInsert(
		`interface ${targetName} ${bodyText}\n\n`,
		componentClass.getStart(),
	);
	const typeArgumentSwap = textSwap(
		targetName,
		literal.getStart(request.sourceFile),
		literal.end,
	);

	return combineMutations(newInterfaceInsertion, typeArgumentSwap);
};

const buildSignatureBodyText = (
	request: FileMutationsRequest,
	literal: ts.TypeLiteralNode,
	memberName: string,
	newTypeText: string,
): string => {
	const literalStart = literal.getStart(request.sourceFile);
	const literalText = literal.getText(request.sourceFile);
	const existingMember = findExistingMember(literal, memberName);

	if (existingMember === undefined) {
		const { insertionPoint, needsLeadingSeparator } = getEndInsertionPoint(
			request.sourceFile,
			literal,
		);
		const separator = needsLeadingSeparator ? ";\n\t" : "";
		const offset = insertionPoint - literalStart;

		return (
			literalText.slice(0, offset) +
			`${separator}${memberName}: ${newTypeText};\n` +
			literalText.slice(offset)
		);
	}

	const typeStartOffset =
		existingMember.type.getStart(request.sourceFile) - literalStart;
	const typeEndOffset = existingMember.type.end - literalStart;

	return (
		literalText.slice(0, typeStartOffset) +
		newTypeText +
		literalText.slice(typeEndOffset)
	);
};

const createReferenceRenameMutations = (
	request: FileMutationsRequest,
	nameNode: ts.Identifier,
	targetName: string,
): Mutation[] => {
	const referencingNodes =
		request.fileInfoCache.getNodeReferencesAsNodes(nameNode) ?? [];

	return referencingNodes.map((node) => {
		// The reference lookup can return an ancestor of the identifier itself
		// (e.g. the whole `Foo["bar"]` IndexedAccessTypeNode when renaming `Foo`),
		// since it shares that ancestor's start position. Narrow down to the
		// identifier so the rename doesn't also swallow a trailing `["bar"]`.
		const identifierNode = narrowToInnermostNodeAtSameStart(
			request.sourceFile,
			node,
		);

		return textSwap(
			targetName,
			identifierNode.getStart(request.sourceFile),
			identifierNode.end,
		);
	});
};

const ensureNoNameCollision = (
	sourceFile: ts.SourceFile,
	targetName: string,
	excludeDeclaration: ts.Statement | undefined,
): void => {
	const existing = getTopLevelDeclaredNames(sourceFile).get(targetName);
	if (existing !== undefined && existing !== excludeDeclaration) {
		throw new Error(
			`Cannot normalize a Glimmer component's Signature to '${targetName}' in '${sourceFile.fileName}': that name is already bound by an unrelated declaration.`,
		);
	}
};

const getTopLevelDeclaredNames = (
	sourceFile: ts.SourceFile,
): Map<string, ts.Statement> => {
	const namesToStatements = new Map<string, ts.Statement>();

	for (const statement of sourceFile.statements) {
		if (
			(ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement)) &&
			statement.name !== undefined
		) {
			namesToStatements.set(statement.name.text, statement);
			continue;
		}

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					namesToStatements.set(declaration.name.text, statement);
				}
			}
		}
	}

	return namesToStatements;
};

const ensureNotGlimmerJsFileWithExistingSignature = (
	sourceFile: ts.SourceFile,
): void => {
	if (/\.gjs$/i.test(sourceFile.fileName)) {
		throw new Error(
			`Found an existing Signature type argument in a .gjs file ('${sourceFile.fileName}'), which should be impossible -- .gjs files can't contain TypeScript generic syntax. This file may already be in a broken state.`,
		);
	}
};

const warnAboutSignatureConversion = (
	request: FileMutationsRequest,
	from: string,
	targetName: string,
): void => {
	request.options.output.stdout(
		`Converting ${from} to interface '${targetName}' for a Glimmer component's Signature in '${request.sourceFile.fileName}'.\n`,
	);
};

const patchExistingSignatureMember = (
	request: FileMutationsRequest,
	node: SignatureMembersNode,
	memberName: string,
	newTypeText: string,
): Mutation | undefined => {
	const existingMember = findExistingMember(node, memberName);

	if (existingMember === undefined) {
		const { insertionPoint, needsLeadingSeparator } = getEndInsertionPoint(
			request.sourceFile,
			node,
		);
		const separator = needsLeadingSeparator ? ";\n\t" : "";

		return textInsert(
			`${separator}${memberName}: ${newTypeText};\n`,
			insertionPoint,
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

const getEndInsertionPoint = (
	sourceFile: ts.SourceFile,
	node: SignatureMembersNode,
): { insertionPoint: number; needsLeadingSeparator: boolean } => {
	if (node.members.length === 0) {
		return { insertionPoint: node.end - 1, needsLeadingSeparator: false };
	}

	const lastMember = node.members[node.members.length - 1];
	const lastCharacter = sourceFile.text[lastMember.end - 1];
	const hasTrailingSeparator = lastCharacter === ";" || lastCharacter === ",";

	return {
		insertionPoint: Math.min(
			lastMember.end + (hasTrailingSeparator ? 1 : 0),
			node.end,
		),
		needsLeadingSeparator: !hasTrailingSeparator,
	};
};
