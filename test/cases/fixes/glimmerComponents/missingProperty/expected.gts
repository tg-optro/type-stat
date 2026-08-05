import Component from '@glimmer/component';

export default class Greeter extends Component {
excited: boolean;
	constructor() {
		this.excited = true;
	}

	<template>
		<p>Hello{{if this.excited '!' ''}}</p>
	</template>
}
