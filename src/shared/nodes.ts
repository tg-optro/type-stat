import * as tsutils from "ts-api-utils";
import ts from "typescript";

import { FileMutationsRequest } from "./fileMutator.js";
import { getValueDeclarationOfType, NodeSelector } from "./nodeTypes.js";

/**
 * Finds a node in a source file by its starting position.
 */
export const findNodeByStartingPosition = (
	sourceFile: ts.SourceFile,
	start: number,
): ts.Node | undefined => {
	if (start >= sourceFile.end) {
		throw new Error(
			`Cannot request start ${start} outside of source file '${sourceFile.fileName}'.`,
		);
	}

	const visitNode = (node: ts.Node): ts.Node | undefined => {
		const nodeStart = node.getStart(sourceFile);
		if (nodeStart === start) {
			return node;
		}

		if (nodeStart > start || node.end < start) {
			return undefined;
		}

		return ts.forEachChild(node, visitNode);
	};

	return ts.forEachChild(sourceFile, visitNode);
};

/**
 * Narrows a node down to its most specific (innermost) descendant that still
 * starts at the exact same source position.
 *
 * Several sibling-nested node kinds can share their leftmost token's start
 * position with an ancestor -- e.g. in `Foo["bar"]`, the `IndexedAccessTypeNode`,
 * its `objectType` `TypeReferenceNode`, and that `TypeReferenceNode`'s `typeName`
 * `Identifier` all start at the same offset. `findNodeByStartingPosition` (and
 * anything built on it, like reference lookups) intentionally returns the
 * outermost such node, since most callers want the surrounding statement or
 * expression. Callers that specifically need the identifier-level node itself
 * -- for example, to safely rename just that identifier without also
 * overwriting a trailing `["bar"]` -- should narrow down to it with this
 * helper instead of assuming the node returned is already an `Identifier`.
 */
export const narrowToInnermostNodeAtSameStart = (
	sourceFile: ts.SourceFile,
	node: ts.Node,
): ts.Node => {
	const start = node.getStart(sourceFile);

	const visitNode = (candidate: ts.Node): ts.Node | undefined => {
		if (candidate.getStart(sourceFile) !== start) {
			return undefined;
		}

		return ts.forEachChild(candidate, visitNode) ?? candidate;
	};

	return visitNode(node) ?? node;
};

/**
 * Checks whether a node's position is completely within a parent node's.
 */
export const isNodeWithinNode = (
	sourceFile: ts.SourceFile,
	child: ts.Node,
	parent: ts.Node,
): boolean =>
	child.end <= parent.end &&
	child.getStart(sourceFile) >= parent.getStart(sourceFile);

export const getParentOfKind = <TNode extends ts.Node = ts.Node>(
	node: ts.Node,
	selector: NodeSelector<TNode>,
): TNode | undefined => {
	if ((node.parent as ts.Node | undefined) === undefined) {
		return undefined;
	}

	node = node.parent;

	if (selector(node)) {
		return node;
	}

	return getParentOfKind(node.parent, selector);
};

/**
 * @returns Whether a node is a binary expression that sets a value with an equals token.
 * This only looks at = assignments, ignoring others such as +=.
 */
export const isNodeAssigningBinaryExpression = (
	node: ts.Node,
): node is ts.BinaryExpression =>
	ts.isBinaryExpression(node) && tsutils.isEqualsToken(node.operatorToken);

/**
 * Gets a variable initializer for an expression, if one exists.
 * If a parent is provided, it will ignore an initializer not within that parent.
 */
export const getVariableInitializerForExpression = (
	request: FileMutationsRequest,
	expression: ts.Expression,
	parentFunctionLike:
		| ts.Block
		| ts.FunctionLikeDeclaration
		| ts.SourceFile
		| undefined,
): ts.Expression | undefined => {
	if (!ts.isIdentifier(expression)) {
		return undefined;
	}

	const valueDeclaration = getValueDeclarationOfType(request, expression);
	if (
		valueDeclaration === undefined ||
		(parentFunctionLike !== undefined &&
			!isNodeWithinNode(
				request.sourceFile,
				valueDeclaration,
				parentFunctionLike,
			))
	) {
		return undefined;
	}

	if (
		!ts.isVariableDeclaration(valueDeclaration) ||
		valueDeclaration.initializer === undefined
	) {
		return undefined;
	}

	return valueDeclaration.initializer;
};

export const getExpressionWithin = (node: ts.Node) =>
	ts.isExpressionStatement(node) ? node.expression : node;

export const getCloseAncestorCallOrNewExpression = (
	node: ts.Node,
): ts.CallExpression | ts.NewExpression | undefined => {
	if (ts.isSourceFile(node.parent) || tsutils.isBlockLike(node)) {
		return undefined;
	}

	if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
		return node;
	}

	return getCloseAncestorCallOrNewExpression(node.parent);
};

export const getClassExtendsType = (
	node: ts.ClassLikeDeclaration,
): ts.ExpressionWithTypeArguments | undefined => {
	const { heritageClauses } = node;
	if (heritageClauses === undefined) {
		return undefined;
	}

	const classExtension = heritageClauses.find(
		(clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
	);
	if (classExtension === undefined) {
		return undefined;
	}

	return classExtension.types.length === 1
		? classExtension.types[0]
		: undefined;
};
