# Verified compiler and editor learnings

## Preserve the compiler's accepted values

Optional `never` and optional `undefined` allow different assignments with `exactOptionalPropertyTypes` enabled. A plain undefined/missing property type is insufficient proof on its own. `isDeclaredNever` compares the compiler's public undefined type in exact mode and requires source proof otherwise; ambiguous mapped transformations keep the compiler's existing representation. The readability suite and copied-type matrix cover both compiler modes.

Naming an alias is also a semantic claim. In particular, `Required<{ value?: Maybe }>` can remove `undefined` from a long `Maybe` union. A preview must not name the wider alias afterward. Match actual member identity; only ignore implied undefined for a genuinely optional property with exact optional types disabled. See the mapping/removal regression in `test/unit/readability.test.cjs`.

Scoped aliases must remain valid at the hovered file's scope. Two namespaces can each export `Choice`; retaining bare `Choice` in a copied outer object loses both names. For scoped declarations, ask the public TypeScript printer for a fully qualified name in the source-file context. It produces `A.Choice` for an accessible export and expands an inaccessible private alias. Keep top-level module aliases on the existing short-name path. The scoped-alias regression checks normal and full copies in both optional-property modes.

Hover-only never summaries require an explicit renderer capability. Both Copy commands retain actual optional-never declarations; an older client without that capability receives individual fields. Do not shorten copied constraints into comments.

## Keep compaction conservative and bounded

Whole-enum naming checks that every declared enum member is present. Subsets and single members stay distinct. Short complete literal unions remain expanded; an incomplete nested named union can retain its name, and the hovered root still expands.

Shared fields require identical resolved type objects, optionality, readonly and never status in every non-never branch. A conflict-reduced intersection can remain a union member even though it is equivalent to `never`; it must not prevent safe factoring. Signature-bearing/indexed objects and other unsupported shapes keep the original layout.

New preprocessing scans need the same cancellation and elapsed-time limits as tree rendering. The cancellation regression requests cancellation during actual property-type reads and checks that the remaining fields are not scanned.

## Verify the installed artifact and painted hover separately

An installed extension's plugin `main` can name a directory. Node's module resolution, rather than a direct file hash of that path, identifies the actual entry.

A focused native hover can remain on the previous symbol after the editor selection changes. Metadata and `executeHoverProvider` text do not prove which popup is painted. Dismiss the old hover, require visible content for the new symbol, then capture it. Tall native hovers intentionally scroll; inspect their final branches too.

Own-renderer Electron captures can verify an isolated editor without recording the desktop. Match the exact test-process identity, profile, loopback listener and workbench target. This does not grant access to another app or the working editor.

Keep disposable VS Code integration-profile paths short. A version-specific profile path exceeded the macOS Unix socket path bound and failed during startup with `listen EINVAL`, before any tests ran. Shortening the disposable profile directory to `ip` allowed the same final artifact's 73/73 integration tests to run successfully. Treat this as test-host setup failure, not an extension test failure; do not change the user's working profile to work around it.

Local package files, extension-host activation and TypeScript-plugin registration are separate evidence. Keep their identities and hashes tied to the reviewed VSIX. Preserve the original extension and the prior scoped settings for rollback. The release process lives in [PRIVATE-RELEASE.md](docs/PRIVATE-RELEASE.md).
