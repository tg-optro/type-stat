import Component from '@glimmer/component';
import { Owner } from '@ember/owner';

interface GreeterSignature {
	Args: {
		name: string;
	};
}

export default class Greeter extends Component<GreeterSignature> {
	constructor(owner: Owner, args: GreeterSignature['Args']) {
		super(owner, args);
	}

	<template>
		<p>Hello {{@name}}</p>
	</template>
}
