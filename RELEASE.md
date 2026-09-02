# Release Policy

This policy applies to maintainers of `@sagmans/pi-ptc`.

## Required gates

Before a version tag is created:

1. Merge the candidate through a reviewed pull request.
2. Confirm hosted CI is green on the merged commit.
3. Run `npm run verify:ci` and `npm run test:bun` locally.
4. Pack once, then run `npm run smoke -- --tarball /absolute/package.tgz` against that archive.
5. Exercise `/ptc on`, one read-only PTC call, `/ptc off`, and unsupported-host inert recovery in a disposable Pi directory.
6. Date the target changelog section and keep exactly one `Unreleased` section.
7. Confirm `package.json` version equals the intended `vX.Y.Z` tag.

Never waive a failed package, runtime, security, or compatibility gate. Fix the candidate and repeat verification.

## Programmatic setup

The CLI-only procedure in [npm release setup](docs/npm-release-setup.md) provisions GitHub approval controls, performs the one-time package bootstrap, configures npm trusted publishing, hardens package publication, and verifies the resulting state. Every mutation has a read-only `DRY_RUN=1` preview and an action-specific `CONFIRM` value.

Only interactive npm authentication and explicit release approval require the maintainer. Do not use a web UI when the npm or GitHub CLI supports the same operation.

## First release

npm trusted publishing cannot be configured until the package exists. The `v0.1.0` release workflow therefore packages and verifies the tag but skips its publish job.

After the workflow succeeds, check out the exact signed tag with a clean tree and run the bootstrap script from [npm release setup](docs/npm-release-setup.md). It authenticates the expected npm user, requires the package namespace to match that user, proves the package is absent for that authenticated registry view, packs once, smokes and dry-runs that archive, then publishes the same archive through interactive 2FA.

Configure trusted publishing and hardening immediately after bootstrap. The initial local publish has no provenance. Releases after `v0.1.0` publish through GitHub OIDC with provenance.

## Recurring release

1. Prepare version and changelog changes on a release branch.
2. Merge through review after all gates pass.
3. Refresh the merged commit and repeat local verification.
4. Create and verify signed tag `vX.Y.Z`.
5. Obtain explicit approval before pushing the tag.
6. Observe the package and verification jobs.
7. Approve the `npm-release` environment only after package name, version, tag, commit, and artifact evidence match.
8. Verify npm metadata, integrity, provenance, package contents, and isolated installation.
9. Create the GitHub release from the verified tag with `gh release create`.

## Recovery

Do not delete or replace a published version or pushed release tag. Deprecate a bad version, publish a forward fix, and update release notes. Unpublishing is exceptional because it can break users and permit dependency confusion.

For authentication failure, compare npm trusted-publisher owner, repository, workflow filename, environment, allowed action, hosted runner, and `id-token: write` exactly. Never add a token fallback to diagnose OIDC.
