import Component from '@glimmer/component';

interface GreeterSignature {
	Args: {
		name: string;
	};
}

export default class Greeter extends Component<GreeterSignature> {
	constructor(owner, args) {
		super(owner, args);
	}

	<template>
		<p>Hello {{@name}}</p>
	</template>
}
