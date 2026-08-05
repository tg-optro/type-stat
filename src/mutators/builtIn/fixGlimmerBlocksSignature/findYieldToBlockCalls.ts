import ts from "typescript";

export interface YieldToBlockCall {
	readonly blockName: string;
	readonly yieldedArguments: readonly ts.Expression[];
}

export const findYieldToBlockCalls = (
	sourceFile: ts.SourceFile,
): readonly YieldToBlockCall[] => {
	const calls: YieldToBlockCall[] = [];

	const visit = (node: ts.Node): void => {
		const call = tryReadYieldToBlockCall(node);
		if (call !== undefined) {
			calls.push(call);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return calls;
};

const tryReadYieldToBlockCall = (
	node: ts.Node,
): undefined | YieldToBlockCall => {
	if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression)) {
		return undefined;
	}

	const innerCall = node.expression;
	if (
		!ts.isPropertyAccessExpression(innerCall.expression) ||
		!ts.isIdentifier(innerCall.expression.expression) ||
		innerCall.expression.expression.text !== "__glintDSL__" ||
		innerCall.expression.name.text !== "yieldToBlock"
	) {
		return undefined;
	}

	if (innerCall.arguments.length < 2) {
		return undefined;
	}

	const blockNameArgument = innerCall.arguments[1];
	if (!ts.isStringLiteralLike(blockNameArgument)) {
		return undefined;
	}

	return {
		blockName: blockNameArgument.text,
		yieldedArguments: node.arguments,
	};
};
