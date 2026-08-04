import Component from "@glimmer/component";

export default class Outer extends Component {
	get greeting() {
		return "Hello";
	}

	<template>
		<Inner @greeting={{this.greeting}} />
	</template>
}

export class Inner extends Component {
    <template>
        <div>
            {{@greeting}}
        </div>
    </template>
}
