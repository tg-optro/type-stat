import { type TransformedModule } from "@glint/ember-tsc/transform";
import { type Mutation, type MutationRange, type Mutations } from "automutate";

const isMultipleMutation = (mutation: Mutation): mutation is Mutations =>
	mutation.type === "multiple" && "mutations" in mutation;

export const remapGlimmerMutations = (
	mutations: readonly Mutation[],
	transform: TransformedModule,
): readonly Mutation[] =>
	mutations
		.map((mutation) => remapMutation(mutation, transform))
		.filter((mutation): mutation is Mutation => mutation !== undefined);

const remapMutation = (
	mutation: Mutation,
	transform: TransformedModule,
): Mutation | undefined => {
	if (isMultipleMutation(mutation)) {
		const remappedChildren = remapGlimmerMutations(
			mutation.mutations,
			transform,
		);
		if (
			remappedChildren.length === 0 ||
			!hasOriginalPosition(mutation.range, transform)
		) {
			return undefined;
		}

		const remapped: Mutations = {
			...mutation,
			mutations: remappedChildren,
			range: remapRange(mutation.range, transform),
		};

		return remapped;
	}

	if (!hasOriginalPosition(mutation.range, transform)) {
		return undefined;
	}

	return {
		...mutation,
		range: remapRange(mutation.range, transform),
	};
};

const remapRange = (
	range: MutationRange,
	transform: TransformedModule,
): MutationRange => ({
	begin: transform.getOriginalOffset(range.begin).offset,
	end:
		range.end === undefined
			? undefined
			: transform.getOriginalOffset(range.end).offset,
});

/**
 * `rewriteModule` wraps every <template> in synthetic glue (the
 * `templateForBackingValue(this, function(__glintRef__, __glintDSL__) {...})`
 * callback) that has no counterpart in the original file at all. Positions
 * inside that glue still resolve via `getOriginalOffset` (every transformed
 * offset maps to *some* correlated span), but they collapse to the enclosing
 * span's raw `originalStart` regardless of how deep into the span the query
 * actually was -- unlike genuinely-mapped content (real template constructs),
 * which resolves to a distinct, non-boundary offset. A mutation whose
 * position exhibits this collapse is targeting Glint's scaffolding, not real
 * source, and must be dropped rather than written into the user's file.
 */
const hasOriginalPosition = (
	range: MutationRange,
	transform: TransformedModule,
): boolean =>
	isGenuinelyMappedOffset(range.begin, transform) &&
	(range.end === undefined || isGenuinelyMappedOffset(range.end, transform));

const isGenuinelyMappedOffset = (
	transformedOffset: number,
	transform: TransformedModule,
): boolean => {
	const enclosingSpan = transform.correlatedSpans.find(
		(span) =>
			transformedOffset >= span.transformedStart &&
			transformedOffset < span.transformedStart + span.transformedLength,
	);

	if (enclosingSpan === undefined) {
		return true;
	}

	if (transformedOffset === enclosingSpan.transformedStart) {
		return true;
	}

	const { offset: originalOffset } =
		transform.getOriginalOffset(transformedOffset);
	return originalOffset !== enclosingSpan.originalStart;
};
