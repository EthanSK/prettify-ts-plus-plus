# Release process

This guide retains its original `PRIVATE-RELEASE.md` filename so links from the private development phase
continue to resolve. Prettify TypeScript++ is now prepared for public Preview releases under publisher `EthanSK`.

## Build one candidate

1. Use Node 24 and the pnpm version declared in `package.json`; install with the checked-in lockfile.
2. Review the changed source and run `pnpm typecheck`, `pnpm lint` and `pnpm test:unit`.
3. Build, then package once with `node scripts/package.js /absolute/output.vsix`. Inspect the archive's manifest,
   bundled extension/plugin, README, changelog, MIT licence and icon. Record its SHA-256.
4. Preserve the original Myles Murphy copyright and MIT permission notice in source and every package.
   Check notices for any added bundled dependencies. Build tools and the editor's TypeScript runtime are not
   redistributed merely because they appear in development dependencies.
5. Check the complete Git history being made public and the actual archive for private data and credentials.
   Local investigation notes, real private-project probes, model prompts/results and ledgers are not release files.

Keep the extension ID, plugin package, commands, settings and request protocol separate from upstream.
Both Copy commands must preserve the compiler's constraints; hover-only compaction must remain explicit.

## Local installation and checks

Install a reviewed viable local batch promptly when runtime code changes; keep a recoverable prior package,
existing settings, unsaved buffers, terminals and running jobs. Do not reinstall unchanged runtime code just
because a release is being prepared. A metadata-only first Marketplace release can keep the tested local
runtime in use until the supported Gallery installation is available.

**Local VSIX installation resets auto-update:** VS Code's CLI installs a VSIX as a specific version and pins
it. Preserve the user's chosen per-extension update setting after a necessary local install; do not silently
leave automatic updates off. Never edit VS Code's state database or private extension metadata to fake a fix.

Verify installed files separately from loaded runtime. Use an isolated editor profile on a separate test machine
for host tests, and preserve the working editor. Compiler-only checks do not prove the painted hover.
Reuse exact earlier evidence for byte-identical runtime bundles and label that reuse explicitly.

## Publish and verify

1. Finish the candidate's applicable tests and source review. Inspect the actual staged and untracked paths.
2. Commit and push the reviewed source, preserving meaningful implementation history and upstream attribution.
3. Publish the exact verified VSIX with `vsce publish --packagePath /absolute/output.vsix`, using the existing
   publisher authorization without printing or storing credentials.
4. Treat upload success as pending. Run `scripts/verify-marketplace-release.mjs --vsix /absolute/output.vsix`
   with `VSCE_PAT` supplied privately to the process. It requires authenticated publisher validation, public
   validated-only latest-version visibility and an exact downloaded archive/hash match.
5. If upload times out, inspect the publisher's exact version before retrying; an older public Gallery response
   does not prove that the upload failed. Do not publish the same version again while validation is pending.
6. Reconcile the local installation with the unversioned Gallery ID:
   `code --install-extension EthanSK.prettify-ts-plus-plus --force`.
   Verify Gallery source/UUID, version, bundle hashes, the user's enabled auto-update preference and the loaded
   TypeScript-plugin route. A matching version number alone is insufficient. Do not use `@version` for normal updates.

CI can package and test candidates. Publication remains an intentional release step; merely changing docs,
pushing source or running a candidate workflow does not publish a Marketplace version.

## Upstream tracking

Keep fixes small enough to rebase. Follow upstream's shared builder and experimental TypeScript 7 API work
before taking on a second language backend. TypeScript 7 native preview currently does not run this fork's
JavaScript TypeScript-server plugin.
