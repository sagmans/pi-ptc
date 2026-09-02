# CLI-only npm Release Setup

Run this procedure from a clean `pi-ptc` repository root. The scripts never install tooling or persist credentials.

## 1. Export exact identities

```bash
export NPM_ACCOUNT='sagmans'
export PKG_NAME='@sagmans/pi-ptc'
export PKG_VERSION='0.1.0'
export REPO='sagmans/pi-ptc'
export WORKFLOW_FILE='release.yml'
export ENVIRONMENT='npm-release'
export REVIEWER='assagman'
export TAG_PATTERN='v*'
```

The npm account must own the user scope. The GitHub reviewer can differ from the repository owner.

## 2. Authenticate only when needed

Check npm authentication:

```bash
npm whoami --registry=https://registry.npmjs.org
```

If it does not print `sagmans`, run:

```bash
npm login --registry=https://registry.npmjs.org
```

Complete the browser/passkey or 2FA challenge yourself. Never paste credentials, recovery codes, tokens, or OTP values into logs or chat.

Confirm GitHub CLI administration access:

```bash
gh auth status
```

## 3. Validate local state

```bash
bash scripts/npm/preflight.sh
```

This checks npm `>=11.15.0`, exact package and repository metadata, clean Git state, release workflow presence, npm identity, and GitHub authentication.

## 4. Provision GitHub release controls

Preview, inspect, then apply:

```bash
DRY_RUN=1 bash scripts/npm/setup-github-release.sh
CONFIRM=setup-github-release bash scripts/npm/setup-github-release.sh
```

This creates or updates the `npm-release` environment, requires reviewer approval, permits only `v*` deployment tags, and protects release-tag creation, update, and deletion with an admin-only ruleset.

## 5. Bootstrap `0.1.0`

Complete all release gates and push the approved signed `v0.1.0` tag. Wait for its package and verify jobs to pass. From a clean checkout of that exact tag:

```bash
DRY_RUN=1 bash scripts/npm/bootstrap-publish.sh
CONFIRM=bootstrap-publish bash scripts/npm/bootstrap-publish.sh
```

The confirmed command reaches npm publication and can require interactive 2FA. Stop if any identity, package, smoke, or dry-run check fails.

## 6. Configure token-free trusted publishing

After npm shows `@sagmans/pi-ptc@0.1.0`:

```bash
DRY_RUN=1 bash scripts/npm/configure-trust.sh
CONFIRM=configure-trust bash scripts/npm/configure-trust.sh
```

The trust is limited to GitHub repository `sagmans/pi-ptc`, workflow `release.yml`, environment `npm-release`, and package publication.

## 7. Disallow traditional publish tokens

```bash
DRY_RUN=1 bash scripts/npm/harden-publishing.sh
CONFIRM=harden-publishing bash scripts/npm/harden-publishing.sh
```

OIDC remains the routine publish path. Do not configure `NPM_TOKEN` or `NODE_AUTH_TOKEN` in GitHub.

## 8. Verify setup

```bash
bash scripts/npm/verify.sh
```

Verification checks version, repository identity, registry integrity, public access, exact publish-only GitHub trust, environment reviewer, tag deployment policy, and the admin-only release-tag ruleset.

## Official references

- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/cli/v12/commands/npm-trust/
- https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
- https://docs.npmjs.com/generating-provenance-statements/
