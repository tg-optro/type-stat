# `glimmerElementSignature`

Whether to infer a Glimmer component's `Element` Signature member from `...attributes` usage in its `<template>`.

This relies on `@glint/ember-tsc`'s template transform to resolve the concrete DOM element type that receives `...attributes`.

## Use Cases

- You're adding Signature types to an existing `.gts` component and don't want to hand-write the `Element` member

## Configuration

```json
{
	"fixes": {
		"glimmerElementSignature": true
	}
}
```

## Mutations

### Element Signature Inference

If a component's template spreads `...attributes` onto an element, that element's concrete DOM type is added or updated as the Signature's `Element` member.

#### Examples: Element Signature Inference

```diff
+interface HighlightSignature {
+	Element: HTMLDivElement;
+}

-export default class Highlight extends Component {
+export default class Highlight extends Component<HighlightSignature> {
	<template>
		<div ...attributes>{{yield}}</div>
	</template>
}
```
