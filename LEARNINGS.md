# Verified compiler and editor learnings

## Preserve the compiler's accepted values

Optional `never` and optional `undefined` allow different assignments with `exactOptionalPropertyTypes` enabled. A plain undefined/missing property type is insufficient proof on its own. `isDeclaredNever` compares the compiler's public undefined type in exact mode and requires source proof otherwise; ambiguous mapped transformations keep the compiler's existing representation. The readability suite and copied-type matrix cover both compiler modes.

Naming an alias is also a semantic claim. In particular, `Required<{ value?: Maybe }>` can remove `undefined` from a long `Maybe` union. A preview must not name the wider alias afterward. Match actual member identity; only ignore implied undefined for a genuinely optional property with exact optional types disabled. See the mapping/removal regression in `test/unit/readability.test.cjs`.

Scoped aliases must remain valid at the hovered file's scope. Two namespaces can each export `Choice`; retaining bare `Choice` in a copied outer object loses both names. For scoped declarations, ask the public TypeScript printer for a fully qualified name in the source-file context. It produces `A.Choice` for an accessible export and expands an inaccessible private alias. Keep top-level module aliases on the existing short-name path. The scoped-alias regression checks normal and full copies in both optional-property modes.

A property's written annotation can still contain `T` after the compiler has instantiated its owner as `Library<number>`. Use the annotation to recognize a skipped type and the resolved type at the hovered location to print its copy. A lexical name can also refer to a different symbol in the consumer. The cross-module copy regressions compile the result alongside the original using the consumer's actual import aliases.

Check the rendered copy itself. Replacing a quoted property name, a default export or `-Infinity` in the test parser hid invalid declarations. TypeScript's printer represents numeric infinity as a numeric-literal node with text `Infinity`. Rendering that node as `1e999` preserves the numeric type, including inside a negative sign or a generic argument, without rewriting identifiers or strings named `Infinity`.

Compare accepted and rejected assignments as well as checking types in both directions. A function-valued property and a method can appear equivalent in a comparison but accept different callbacks under strict function checking. A getter and setter can also accept different read and write types. The compiler audit suite exercises both operations and requires TypeScript to reject the invalid examples.

Hover-only never summaries require an explicit renderer capability. Both Copy commands retain actual optional-never declarations; an older client without that capability receives individual fields. Do not shorten copied constraints into comments.

## Keep compaction conservative and bounded

Whole-enum naming checks that every declared enum member is present. Subsets and single members stay distinct. Short complete literal unions remain expanded; an incomplete nested named union can retain its name, and the hovered root still expands.

Print an enum member from its declared member type to keep singleton and quoted names. For copies, check that the printed name resolves to the intended symbol in the hovered scope. A private enum exposed by a public property may need an indexed access such as `PublicShape["role"]`; an optional indexed read can also add `undefined` that the original write rejected.

Shared fields require identical resolved type objects, optionality, readonly and never status in every non-never branch. A conflict-reduced intersection can remain a union member even though it is equivalent to `never`; it must not prevent safe factoring. Signature-bearing/indexed objects and other unsupported shapes keep the original layout.

New preprocessing scans need the same cancellation and elapsed-time limits as tree rendering. The cancellation regression requests cancellation during actual property-type reads and checks that the remaining fields are not scanned.

## Verify the installed artifact and painted hover separately

Authored source and native hover de-duplication are separate decisions. A useful original helper expression can differ from an expansion that TypeScript already displays. Retain the extension hover when that source section exists, while still skipping a truly redundant expansion when source is absent or identical. The editor regression covers both paths; neither Copy command asks for source metadata.

VS Code 1.144's MarkdownString code-block helper counts backticks only at column zero. Markdown can close a fence after up to three leading spaces, so an indented source comment can escape the generated block. The authored-source renderer chooses an outer fence longer than every backtick run in its bounded text. Keep the raw source unchanged and the Markdown untrusted; check both indented-only and ordinary fences with the real parser/editor.

An installed extension's plugin `main` can name a directory. Node's module resolution, rather than a direct file hash of that path, identifies the actual entry.

A focused native hover can remain on the previous symbol after the editor selection changes. Metadata and `executeHoverProvider` text do not prove which popup is painted. Dismiss the old hover, require visible content for the new symbol, then capture it. Tall native hovers intentionally scroll; inspect their final branches too.

Own-renderer Electron captures can verify an isolated editor without recording the desktop. Match the exact test-process identity, profile, loopback listener and workbench target. This does not grant access to another app or the working editor.

Keep disposable VS Code integration-profile paths short. A version-specific profile path exceeded the macOS Unix socket path bound and failed during startup with `listen EINVAL`, before any tests ran. Shortening the disposable profile directory to `ip` allowed the same final artifact's 73/73 integration tests to run successfully. Treat this as test-host setup failure, not an extension test failure; do not change the user's working profile to work around it.

Local package files, extension-host activation and TypeScript-plugin registration are separate evidence. Keep their identities and hashes tied to the reviewed VSIX. Preserve the original extension and the prior scoped settings for rollback. The release process lives in [PRIVATE-RELEASE.md](docs/PRIVATE-RELEASE.md).

## Bound what the compiler retains between copies

TypeScript can cache printed type nodes on the enclosing syntax node for the lifetime of a project. Repeatedly printing a structural type at different identifiers can keep a separate copy of its tree at each cursor. Simple literals can omit that scope. Deferred expressions such as `Row[T]` can contain names from another namespace. For those expressions, print at a shared lexical scope only while the bindings stay the same.

The name in `PartialDeep<ObjectArrays>` refers to the generic declaration. The enclosing type reference has the actual object type. Asking the scoped printer to expand the unresolved declaration exhausted an 8 GB compiler heap on type-fest. Request the applied type from the reference node, including for qualified names.

A skipped annotation such as `Array<typeof seed>` can be much shorter than the resolved object. Reuse it only when its type, names and value narrowing still match at the destination. The skipped-reference regression checks the ordinary copy path, shadowed names, narrowed values and a substituted type parameter. Stop a class visibility scan on cancellation before asking the compiler to serialize it.

## Preserve Marketplace updates when releasing

VS Code's CLI installs a local VSIX with `installGivenVersion: true`, which pins the version and disables
its automatic updates again. This can override the user's previously enabled choice. Keep the tested
runtime in use during metadata-only release preparation, then install the published extension by its
unversioned Gallery ID. Check Gallery source/UUID, the effective update preference and loaded plugin
separately; do not edit VS Code's private state or treat an installed version number as activation proof.

The fork's main package is a private workspace container, not the extension identity. Release verification
must read `packages/vscode-extension/package.json`; the shared root version alone is not a Gallery ID.
The exact package needs its README, changelog and original MIT licence, and its public download must
match the uploaded bytes after publisher validation and public latest-version visibility both pass.

Marketplace also requires a distinct extension icon. It rejected the inherited upstream icon as too similar
before creating a publisher version, despite the MIT licence allowing asset reuse. Inspect the publisher's
exact version after a failed upload before resubmitting; do not infer upload state from public search alone.
The fork's published icon is `packages/vscode-extension/assets/logo-plus-plus.png`; the original artwork
remains in source but is excluded from its package.
Marketplace caps the icon file at 1,024 KB. Export the canonical packaged icon at 512 pixels and check
its byte size before upload; the packager now rejects oversized icons before building a release archive.
