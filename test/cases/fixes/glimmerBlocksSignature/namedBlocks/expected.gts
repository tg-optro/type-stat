import Component from "@glimmer/component";

interface CardSignature {
	Blocks: {
	header: [];
	default: [string];
};
}

export default class Card extends Component<CardSignature> {
	get title() {
		return "Card";
	}

	<template>
		<div>
			{{yield to="header"}}
			{{yield this.title}}
		</div>
	</template>
}
