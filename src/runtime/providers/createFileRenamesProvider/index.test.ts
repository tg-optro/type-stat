import { describe, expect, it } from "vitest";

import { fileNameIsJavaScript } from "./index.js";

describe("fileNameIsJavaScript", () => {
	it.each([
		{ expected: true, fileName: "a.js" },
		{ expected: true, fileName: "a.jsx" },
		{ expected: true, fileName: "a.cjs" },
		{ expected: true, fileName: "a.mjs" },
		{ expected: true, fileName: "a.gjs" },
		{ expected: false, fileName: "a.ts" },
		{ expected: false, fileName: "a.tsx" },
		{ expected: false, fileName: "a.gts" },
	])("returns $expected for $fileName", ({ expected, fileName }) => {
		expect(fileNameIsJavaScript(fileName)).toBe(expected);
	});
});
