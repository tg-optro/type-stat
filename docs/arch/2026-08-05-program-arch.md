# Program Flow: Normal vs. Glimmer-Patched

**Date:** 2026-08-05
**Scope:** one wave of `createCoreMutationsProvider` (`src/runtime/providers/createCoreMutationsProvider.ts`),
contrasting the pre-existing `.ts`/`.tsx` flow (blue) against the `.gjs`/`.gts` flow this
branch added on top of it (orange). See
[`docs/research/2026-08-04-type-errors-report.md`](../research/2026-08-04-type-errors-report.md)
for the diagnostic-code-delegation-vs-direct-inference distinction referenced inside the
fixer-execution step below.

```mermaid
flowchart TD
    subgraph WAVE["One wave of createCoreMutationsProvider"]
        direction TB
        A[File in options.fileNames] --> B{isGlimmerFile fileName?}

        B -->|"no: .ts / .tsx"| C[ts.sys.readFile raw contents]
        C --> F[ts.Program / LanguageService built from raw contents]

        B -->|"yes: .gjs / .gts"| C2[ts.sys.readFile raw contents]
        C2 --> D2[computeGlimmerTransform Glint rewriteModule]:::orange
        D2 --> E2[transformedContents substituted for raw text]:::orange
        E2 --> F2[ts.Program / LanguageService built from transformedContents]:::orange

        F --> G[collectFilteredNodes]
        F2 --> G2[collectFilteredNodes, walks desugared template AST too]

        G --> H["findMutationsInFile: run every enabled fixer"]
        G2 --> H2["findMutationsInFile: same 7 fixers, unmodified + fixGlimmerElementSignature + fixGlimmerBlocksSignature"]:::orange

        H --> I[Mutations already in original-file coordinates]
        H2 --> J[Mutations in transformed-content coordinates]
        J --> K["remapGlimmerMutations: getOriginalOffset per mutation, drop synthetic-anchored ones"]:::orange
        K --> I

        I --> L[automutate writes mutations to disk]
    end

    L --> M{Wave produced mutations?}
    M -->|yes| A
    M -->|"no, twice in a row"| N[Done]

    classDef orange fill:#ffe0b3,stroke:#cc7a00,stroke-width:2px,color:#4d2600
    classDef default fill:#cfe0ff,stroke:#2255cc,color:#00204d
```

## Reading this diagram

- **Blue** is every box that existed before this branch: raw-file reads, `ts.Program`
  construction, `collectFilteredNodes`, the fixer-execution step, and `automutate` writing
  mutations to disk. None of this was modified for Glimmer support -- the seven pre-existing
  fixers run exactly as they did before, just against whatever AST the program hands them.
- **Orange** is everything this branch added: the `isGlimmerFile` branch itself, Glint's
  `rewriteModule` transform, content substitution in `createLanguageServices`
  (`src/services/language.ts`), the two new Signature fixers, and `remapGlimmerMutations`
  (`src/runtime/remapGlimmerMutations.ts`).
- The two flows **rejoin** at `automutate writes mutations to disk` -- by the time a mutation
  reaches that step, it's always in original-file coordinates, whether or not it passed
  through the Glimmer branch.
- The Glimmer flow's fixer-execution step (`H2`) is orange only because it _also_ runs two new
  fixers; the seven inherited fixers inside it are unmodified. This is the one node in the
  diagram that's genuinely mixed rather than purely new -- called out explicitly since the
  diagram's two-color scheme can't otherwise represent it.
