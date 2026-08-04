import Component from "@glimmer/component";

interface HighlightSignature {
	Element: HTMLDivElement;
}

export default class Highlight extends Component<HighlightSignature> {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
