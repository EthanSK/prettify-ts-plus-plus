# Changelog

## 1.1.4 — 2026-11-17

First public Preview of Prettify TypeScript++, an MIT-licensed fork of
[Prettify TypeScript](https://github.com/mylesmmurphy/prettify-ts).

- Keep useful enum and union names in complex hovers.
- Explain proven excluded fields together while preserving real declarations in copied types.
- Optionally show properties shared by every union branch once.
- Show the original written definition when it adds useful information, followed by TypeScript's normal hover.
- Bound original-source previews and link to the complete definition.
- Preserve both Copy commands, cancellation and hover size limits.

The type-rendering code is unchanged from the tested private 1.1.3 candidate.
This release adds public documentation, Preview metadata and the Marketplace distribution path.

TypeScript's JavaScript language service is required. TypeScript 7 native preview is not supported.
