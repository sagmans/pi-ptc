import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const RELEASE_WORKFLOW_PATH = path.resolve(".github/workflows/release.yml");
const RELEASE_WORKFLOW = readFileSync(RELEASE_WORKFLOW_PATH, "utf8");
const JOBS_MARKER = "jobs:\n";

function job(name: string, nextName?: string): string {
	const start = RELEASE_WORKFLOW.indexOf(`  ${name}:\n`);
	assert.notEqual(start, -1, `missing ${name} job`);
	const end =
		nextName === undefined
			? RELEASE_WORKFLOW.length
			: RELEASE_WORKFLOW.indexOf(`  ${nextName}:\n`, start + 1);
	assert.notEqual(end, -1, `missing ${nextName} job`);
	return RELEASE_WORKFLOW.slice(start, end);
}

test("release packages once and verifies the exact artifact", () => {
	const packageJob = job("package", "verify");
	const verifyJob = job("verify", "publish");
	assert.match(packageJob, /npm pack --pack-destination artifact/u);
	assert.match(packageJob, /actions\/upload-artifact@[0-9a-f]{40}/u);
	assert.match(verifyJob, /needs: package/u);
	assert.match(verifyJob, /npm run verify:ci/u);
	assert.match(verifyJob, /npm run test:bun/u);
	assert.match(verifyJob, /npm run smoke -- --tarball "\$package"/u);
	assert.doesNotMatch(verifyJob, /continue-on-error:/u);
});

test("publish uses only the verified artifact with OIDC approval", () => {
	const header = RELEASE_WORKFLOW.slice(0, RELEASE_WORKFLOW.indexOf(JOBS_MARKER));
	const publishJob = job("publish");
	assert.match(header, /push:\n\s+tags: \["v\*"\]/u);
	assert.match(header, /permissions:\n\s+contents: read/u);
	assert.doesNotMatch(header, /id-token: write/u);
	assert.match(publishJob, /needs: \[package, verify\]/u);
	assert.match(publishJob, /environment: npm-release/u);
	assert.match(publishJob, /permissions:\n\s+contents: read\n\s+id-token: write/u);
	assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40}/u);
	assert.match(publishJob, /npm publish "\$package" --provenance --access public/u);
	assert.doesNotMatch(
		publishJob,
		/actions\/checkout|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|npm pack/u,
	);
});
