# Prettify TypeScript++

A private fork of [Prettify TypeScript](https://github.com/mylesmmurphy/prettify-ts) for clearer complex-type hovers in VS Code.

The goal is to make large unions readable while keeping the compiler’s meaning intact. Keep useful enum and union names, make excluded fields clear, and optionally show shared fields once rather than repeating them in every branch. Root types still expand so hovering an alias shows its definition.

This is a development candidate, not a public Marketplace release. See [the private release process](docs/PRIVATE-RELEASE.md) for installation, validation and later publication.

## What the fork checks

- Whole enums versus individual enum members and subsets.
- Optional `never` versus explicit `undefined`, with `exactOptionalPropertyTypes` enabled and disabled.
- `ExactlyOneOf`, `AllOrNone`, discriminated unions and intersections.
- Generic, mapped, conditional, indexed and recursive types.
- Readonly and optional fields, callable objects, tuples and index signatures.
- Hover limits, cancellation, settings, and both Copy commands.

A compact hover is a presentation, not a new type system. The compiler remains responsible for accepted values. Copied output must keep actual constraints, even when a hover groups their explanation.

## Build

Use Node 24 and the pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/package.js /absolute/output/prettify-ts-plus-plus.vsix
```

Install the exact reviewed package with VS Code’s **Install from VSIX** command or its `code --install-extension /absolute/output/prettify-ts-plus-plus.vsix` CLI. Enable only the intended hover extension to avoid duplicate prettified previews. Keep the upstream extension available for rollback.

A package installed on disk can differ from the code loaded in an existing editor window. Verify activation separately and preserve live editor work before any extension-host restart.

## Shared fields

Enable `prettify-ts-plus-plus.factorSharedUnionProperties` to show fields shared by every union branch once, followed by the branch differences. It is off by default; readonly, optionality, resolved types and exclusions must match before a field can be shared.

Enum names and proven optional-`never` fields are clearer automatically. Hover summaries can group several excluded fields in a `/* never: ... */` comment; both Copy commands keep real property declarations. Without `exactOptionalPropertyTypes`, an optional `never` field can still explicitly contain `undefined`, just as in the original source.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
```

The [editor test guide](test/README.md) covers real provider, language and packaging checks. Run editor hosts in an isolated profile on a separate test machine rather than the working editor. Compiler-only checks do not prove visual hover quality.

## Upstream and license

Forked from v1.0.2 (`83c6cc8b1e05d116f542924a842395fd37238c34`), with upstream history retained. Original copyright: Myles Murphy. [MIT license](LICENSE).

The fork’s own extension, plugin, settings, commands and request metadata are isolated from upstream. It uses the existing TypeScript server plugin architecture and targets TypeScript 5.9 and 6.0. Current TypeScript 7 native-preview releases do not run this plugin; upstream has an experimental migration in progress.
