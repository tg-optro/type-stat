import Component from "@glimmer/component";

interface SimpleDivSignature {
	Element: HTMLDivElement;
}

export default class SimpleDiv extends Component<SimpleDivSignature> {
	<template>
		<div ...attributes>Hello</div>
	</template>
}
