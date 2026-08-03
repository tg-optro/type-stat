import { type TransformedModule } from "@glint/ember-tsc/transform";
import { type Mutation, type MutationRange, type Mutations } from "automutate";

const isMultipleMutation = (mutation: Mutation): mutation is Mutations =>
	mutation.type === "multiple" && "mutations" in mutation;

export const remapGlimmerMutations = (
	mutations: readonly Mutation[],
	transform: TransformedModule,
): readonly Mutation[] =>
	mutations.map((mutation) => remapMutation(mutation, transform));

const remapMutation = (
	mutation: Mutation,
	transform: TransformedModule,
): Mutation => {
	if (isMultipleMutation(mutation)) {
		const remapped: Mutations = {
			...mutation,
			mutations: remapGlimmerMutations(mutation.mutations, transform),
			range: remapRange(mutation.range, transform),
		};

		return remapped;
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
