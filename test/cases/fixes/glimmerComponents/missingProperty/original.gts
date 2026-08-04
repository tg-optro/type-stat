import Component from '@glimmer/component';

export default class Greeter extends Component {
	constructor() {
		super(...arguments);
		this.excited = true;
	}

	<template>
		<p>Hello{{if this.excited '!' ''}}</p>
	</template>
}
