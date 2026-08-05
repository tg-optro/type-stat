import Component from "@glimmer/component";

interface SharedListSignature {
	Args: {
		items: string[];
	};
}

function describeArgs(args: SharedListSignature["Args"]): string {
	return args.items.join(", ");
}

export default class UnorderedList extends Component<SharedListSignature> {
	<template>
		<ul>
			{{#each @items as |item|}}
				<li>{{yield item}}</li>
			{{/each}}
		</ul>
	</template>
}
