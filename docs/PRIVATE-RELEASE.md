# Private release process

Prettify TypeScript++ is a private fork of [Prettify TypeScript](https://github.com/mylesmmurphy/prettify-ts), starting at v1.0.2 (`83c6cc8b1e05d116f542924a842395fd37238c34`). Preserve its MIT copyright and license in source and every VSIX.

The fork uses its own extension ID, plugin package, commands, settings and request metadata. An upstream plugin must never answer the fork's private protocol or register the same commands. Keep the old product name searchable beside the new protocol owner.

## Local candidate

1. Build with the checked-in package-manager version and lockfile: `pnpm install --frozen-lockfile`, then `pnpm build`.
2. Review the actual source, including new files. Check compiler fidelity, correct bounds, cancellation, copy semantics and adjacent behavior.
3. Package one candidate with `node scripts/package.js /absolute/output.vsix`. Inspect its manifest, bundled plugin, README, MIT license and icon; record the archive's SHA-256.
4. Install the exact reviewed VSIX. Preserve a recoverable prior package and existing settings. Keep working editor windows, unsaved buffers, terminals and debugging sessions intact.
5. Verify installed files separately from loaded runtime. Use an isolated editor profile on a separate test machine for host tests; do not launch development hosts in the user's working editor.
6. Run broader tests after the viable local install: TypeScript versions, strict optional mode on/off, real-project readability, provider, toggle and both Copy commands. A successful build or compiler-only probe does not prove the painted hover.

## Later public release

This document prepares the release process. It does not make the repository or a Marketplace listing public.

The established personal-extension channels are GitHub and VS Code Marketplace under publisher `EthanSK`. Do not inherit another publisher's identity, credentials or Open VSX publication workflow.

When the first public release is authorized:

1. Finish privacy, license, documentation and artifact checks. Exclude local ledgers, private source probes, model prompts/results and credentials.
2. Commit and push the reviewed source, retaining upstream history and attribution.
3. Publish the exact verified VSIX with `vsce publish --packagePath /absolute/output.vsix`; use the existing publisher authorization without printing credentials.
4. Verify publisher validation, public Gallery visibility of the expected latest version, and byte-for-byte identity of the downloaded archive. Upload success alone is not a verified release.
5. Reconcile the local installation through the unversioned Gallery identity so ordinary updates remain available. Check Gallery association, loaded version and effective update settings; a matching version number alone is insufficient.

## Upstream tracking

Keep fixes small enough to rebase. Track upstream's shared builder and experimental TypeScript 7 API work before taking on a second language backend. The currently installed TypeScript 7 native preview does not run this fork's TypeScript server plugin; an experimental upstream migration exists but is not part of this private candidate.
