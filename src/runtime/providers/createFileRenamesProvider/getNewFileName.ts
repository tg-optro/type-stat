import { RenameExtensions } from "../../../options/types.js";

export const getNewFileName = async (
	renameExtensions: RenameExtensions,
	oldFileName: string,
	readFile: (filePath: string) => Promise<string>,
): Promise<string> => {
	const oldExtension = oldFileName.substring(oldFileName.lastIndexOf("."));
	const beforeExtension = oldFileName.substring(
		0,
		oldFileName.length - oldExtension.length,
	);

	// .gjs carries a Glimmer <template> tag, so it can only ever become .gts --
	// forcing it to plain .ts/.tsx per a "ts"/"tsx" setting would silently
	// strip its ability to contain templates.
	if (oldExtension.toLowerCase() === ".gjs") {
		return `${beforeExtension}.gts`;
	}

	if (typeof renameExtensions === "string") {
		return `${beforeExtension}.${renameExtensions}`;
	}

	const fileContents = await readFile(oldFileName);
	const fileContentsJoined = fileContents.replace(/ /g, "").replace(/"/g, "'");

	// eslint-disable-next-line regexp/no-obscure-range
	if (/<\s*\/\s*(?:[A-z.]+\s*)?>|\/\s*>/.test(fileContentsJoined)) {
		return `${beforeExtension}.tsx`;
	}

	return `${beforeExtension}.ts`;
};
