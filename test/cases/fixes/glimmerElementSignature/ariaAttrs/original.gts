import Component from "@glimmer/component";

export default class ToggleButton extends Component {
	get isPressed() {
		return false;
	}

	<template>
		<button aria-pressed={{this.isPressed}} type="button" ...attributes>
			{{yield}}
		</button>
	</template>
}
