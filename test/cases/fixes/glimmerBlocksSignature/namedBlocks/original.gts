import Component from "@glimmer/component";

export default class Card extends Component {
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
