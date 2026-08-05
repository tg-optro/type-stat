# `glimmerBlocksSignature`

Whether to infer a Glimmer component's `Blocks` Signature member from `{{yield ...}}` usage in its `<template>`.

This relies on `@glint/ember-tsc`'s template transform to resolve the concrete types of each yielded value, regardless of what control flow (`{{#each}}`, `{{#let}}`, etc.) surrounds the yield.

## Use Cases

- You're adding Signature types to an existing `.gts` component and don't want to hand-write the `Blocks` member

## Configuration

```json
{
	"fixes": {
		"glimmerBlocksSignature": true
	}
}
```

## Mutations

### Blocks Signature Inference

If a component's template yields values to a block, that block's yielded value types are added or updated as a member of the Signature's `Blocks`.

#### Examples: Blocks Signature Inference

```diff
export default class Highlight extends Component<{
	Args: HighlightArgs;
+	Blocks: {
+		default: [string, number];
+	};
}> {
	<template>
		{{#each this.filtered as |item index|}}
			{{yield item index}}
		{{/each}}
	</template>
}
```
