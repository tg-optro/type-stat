import Component from "@glimmer/component";

interface UnorderedListArgs {
	items: string[];
}

export default class UnorderedList extends Component<{
	Args: UnorderedListArgs;
}> {
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
