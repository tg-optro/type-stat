import Component from "@glimmer/component";

interface HighlightArgs {
	items: string[];
}

export default class Highlight extends Component<{
	Args: HighlightArgs;
Blocks: {
	default: [string, number];
};
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
