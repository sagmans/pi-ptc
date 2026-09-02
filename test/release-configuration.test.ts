import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SCRIPT_DIRECTORY = path.resolve("scripts/npm");
const NPM_ACCOUNT_REFERENCE = "npm account must be $" + "{NPM_ACCOUNT}";
const GH_AUTH_REFERENCE = '"$' + '{GH_BIN}" auth status';
const CONFIRMATION_REFERENCE = 'require_confirmation "$' + '{ACTION}"';

function script(name: string): string {
	return readFileSync(path.join(SCRIPT_DIRECTORY, name), "utf8");
}

test("preflight binds npm and GitHub authentication to declared identities", () => {
	const source = script("preflight.sh");
	assert.ok(source.includes(NPM_ACCOUNT_REFERENCE));
	assert.ok(source.includes(GH_AUTH_REFERENCE));
	assert.match(source, /require_clean_worktree/u);
	assert.match(source, /require_workflow/u);
});

test("GitHub setup is previewable, confirmed, and approval-gated", () => {
	const source = script("setup-github-release.sh");
	assert.match(source, /readonly ACTION='setup-github-release'/u);
	assert.ok(source.includes(CONFIRMATION_REFERENCE));
	assert.match(source, /can_admins_bypass.*false/u);
	assert.match(source, /deployment-branch-policies/u);
	assert.match(source, /release-tags-admin-only/u);
});

test("npm trust and hardening use narrow authenticated mutations", () => {
	const trust = script("configure-trust.sh");
	const harden = script("harden-publishing.sh");
	assert.ok(trust.includes(NPM_ACCOUNT_REFERENCE));
	assert.match(trust, /trust github/u);
	assert.match(trust, /--allow-publish/u);
	assert.ok(harden.includes(NPM_ACCOUNT_REFERENCE));
	assert.match(harden, /access set mfa=publish/u);
});

test("post-setup verification checks npm and GitHub release controls", () => {
	const source = script("verify.sh");
	assert.match(source, /dist integrity or shasum is missing/u);
	assert.match(source, /package is not public/u);
	assert.match(source, /trusted publisher identity does not match/u);
	assert.match(source, /createPackage/u);
	assert.match(source, /deployment-branch-policies/u);
	assert.match(source, /release-tags-admin-only/u);
	assert.match(source, /GitHub environment reviewer does not match REVIEWER/u);
	assert.match(source, /GitHub release ruleset tag pattern does not match TAG_PATTERN/u);
	assert.match(source, /GitHub environment permits administrator bypass/u);
});
