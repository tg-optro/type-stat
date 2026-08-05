import Component from "@glimmer/component";

interface UnorderedListArgs {
	items: string[];
}

interface UnorderedListSignature {
	Args: UnorderedListArgs;
Blocks: {
	default: [string, number];
};
}

export default class UnorderedList extends Component<UnorderedListSignature> {
	get filtered() {
		return this.args.items.filter(Boolean);
	}

	<template>
		<ul>
			{{#each this.filtered as |item index|}}
				<li>{{yield item index}}</li>
			{{/each}}
		</ul>
	</template>
}
