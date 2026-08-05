import { FileMutator } from "../../shared/fileMutator.js";
import { fixGlimmerBlocksSignature } from "./fixGlimmerBlocksSignature/index.js";
import { fixGlimmerElementSignature } from "./fixGlimmerElementSignature/index.js";
import { fixImportExtensions } from "./fixImportExtensions/index.js";
import { fixIncompleteTypes } from "./fixIncompleteTypes/index.js";
import { fixMissingProperties } from "./fixMissingProperties/index.js";
import { fixNoImplicitAny } from "./fixNoImplicitAny/index.js";
import { fixNoImplicitThis } from "./fixNoImplicitThis/index.js";
import { fixNoInferableTypes } from "./fixNoInferableTypes/index.js";
import { fixStrictNonNullAssertions } from "./fixStrictNonNullAssertions/index.js";

export const builtInFileMutators: readonly [string, FileMutator][] = [
	["fixGlimmerBlocksSignature", fixGlimmerBlocksSignature],
	["fixGlimmerElementSignature", fixGlimmerElementSignature],
	["fixImportExtensions", fixImportExtensions],
	["fixIncompleteTypes", fixIncompleteTypes],
	["fixMissingProperties", fixMissingProperties],
	["fixNoImplicitAny", fixNoImplicitAny],
	["fixNoImplicitThis", fixNoImplicitThis],
	["fixNoInferableTypes", fixNoInferableTypes],
	["fixStrictNonNullAssertions", fixStrictNonNullAssertions],
];
