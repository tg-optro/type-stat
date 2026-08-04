import Component from "@glimmer/component";

export default class Highlight extends Component {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
