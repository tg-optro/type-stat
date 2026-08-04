import Component from "@glimmer/component";

interface ToggleButtonSignature {
	Element: HTMLButtonElement;
}

export default class ToggleButton extends Component<ToggleButtonSignature> {
	get isPressed() {
		return false;
	}

	<template>
		<button aria-pressed={{this.isPressed}} type="button" ...attributes>
			{{yield}}
		</button>
	</template>
}
