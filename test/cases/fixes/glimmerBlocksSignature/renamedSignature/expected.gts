import Component from "@glimmer/component";

interface UnorderedListSignature {
	Args: {
		items: string[];
	};
Blocks: {
	default: [string];
};
}

function describeArgs(args: UnorderedListSignature["Args"]): string {
	return args.items.join(", ");
}

export default class UnorderedList extends Component<UnorderedListSignature> {
	<template>
		<ul>
			{{#each @items as |item|}}
				<li>{{yield item}}</li>
			{{/each}}
		</ul>
	</template>
}
