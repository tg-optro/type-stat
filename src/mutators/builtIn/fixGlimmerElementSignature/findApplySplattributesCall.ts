import ts from "typescript";

export const findApplySplattributesCall = (
	sourceFile: ts.SourceFile,
): ts.CallExpression | undefined => {
	let found: ts.CallExpression | undefined;

	const visit = (node: ts.Node): void => {
		if (found !== undefined) {
			return;
		}

		if (isApplySplattributesCall(node)) {
			found = node;
			return;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
};

const isApplySplattributesCall = (node: ts.Node): node is ts.CallExpression =>
	ts.isCallExpression(node) &&
	ts.isPropertyAccessExpression(node.expression) &&
	ts.isIdentifier(node.expression.expression) &&
	node.expression.expression.text === "__glintDSL__" &&
	node.expression.name.text === "applySplattributes";
