import ts from "typescript";

export const findComponentClassDeclaration = (
	sourceFile: ts.SourceFile,
): ts.ClassDeclaration | undefined => {
	for (const statement of sourceFile.statements) {
		if (ts.isClassDeclaration(statement) && classExtendsComponent(statement)) {
			return statement;
		}
	}

	return undefined;
};

const classExtendsComponent = (node: ts.ClassDeclaration): boolean =>
	(node.heritageClauses ?? []).some(
		(clause) =>
			clause.token === ts.SyntaxKind.ExtendsKeyword &&
			clause.types.some(
				(type) =>
					ts.isIdentifier(type.expression) &&
					type.expression.text === "Component",
			),
	);
