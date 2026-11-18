# Changelog

## 1.1.5 — 2026-11-18

- Keep enum members and generic wrappers qualified where they are used, including renamed imports and quoted enum members.
- Hovering a generic at its use site now shows its actual arguments. For example, `Box<number>` shows a numeric field, and a recursive library type can resolve without expanding its entire definition.
- Copy the resolved arguments of skipped types. For example, a field from `Library<number>` copies as `Map<string, number>` while its hover stays compact.
- Show string transformations such as `Uppercase<string>` on one line. Preserve narrowing, optional tuple syntax, abstract constructors, method signatures, getter and setter types, and unique symbol identities in copied types.
- Copy a class variable with its configured visible fields and preserve the identity of private and protected members. Preserve public properties whose quoted names start with `#`.
- Keep references such as `Array<typeof seed>` compact when their names still resolve at the cursor. Reuse the compiler’s printed types across nearby copies.
- Produce valid copy declarations for quoted property names and default exports. Preserve positive and negative numeric infinity literals in copies.
- Keep distinct hovers visible and remove duplicate sections that differ only in quote style. Saved `unwrapPromises: false` settings work when no explicit generic list overrides them.
- Keep the most recent Copy command when requests overlap, preserve complete characters when shortening a hover, and bound excessive indentation.

## 1.1.4 — 2026-11-17

First public Preview of Prettify TypeScript++, an MIT-licensed fork of
[Prettify TypeScript](https://github.com/mylesmmurphy/prettify-ts).

- Keep useful enum and union names in complex hovers.
- Explain proven excluded fields together while preserving real declarations in copied types.
- Optionally show properties shared by every union branch once.
- Show the original written definition when it adds useful information, followed by TypeScript's normal hover.
- Bound original-source previews and link to the complete definition.
- Preserve both Copy commands, cancellation and hover size limits.
- Give the independent fork its own extension icon.

The type-rendering code is unchanged from the tested private 1.1.3 candidate.
This release adds public documentation, Preview metadata and the Marketplace distribution path.

TypeScript's JavaScript language service is required. TypeScript 7 native preview is not supported.
