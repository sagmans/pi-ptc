#!/usr/bin/env bash
# Verify npm identity and GitHub release controls before another publication.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly REGISTRY='https://registry.npmjs.org'
readonly NPM_ACCOUNT="${NPM_ACCOUNT:-}"
readonly PKG_NAME="${PKG_NAME:-}"
readonly PKG_VERSION="${PKG_VERSION:-}"
readonly REPO="${REPO:-}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly REVIEWER="${REVIEWER:-}"
readonly TAG_PATTERN="${TAG_PATTERN:-}"
readonly RULESET_NAME='release-tags-admin-only'

validate_account "${NPM_ACCOUNT}"
validate_package_name "${PKG_NAME}"
validate_version "${PKG_VERSION}"
validate_repository "${REPO}"
validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
validate_reviewer "${REVIEWER}"
validate_tag_pattern "${TAG_PATTERN}"
require_workflow "${WORKFLOW_FILE}"
require_command "${NPM_BIN}"
require_command "${GH_BIN}"
require_command "${NODE_BIN}"
require_npm_version
require_npm_identity "${NPM_ACCOUNT}"
bash "${SCRIPT_DIR}/validate-workflow.sh" >/dev/null
"${GH_BIN}" auth status >/dev/null 2>&1 || fail 'GitHub authentication check failed'

metadata_file="$(mktemp)"
access_file="$(mktemp)"
trust_file="$(mktemp)"
environment_file="$(mktemp)"
policies_file="$(mktemp)"
ruleset_file="$(mktemp)"
trap 'rm -f -- "${metadata_file}" "${access_file}" "${trust_file}" "${environment_file}" "${policies_file}" "${ruleset_file}"' EXIT

if "${NPM_BIN}" view "${PKG_NAME}@${PKG_VERSION}" name version repository dist --json --registry "${REGISTRY}" >"${metadata_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read package metadata\n' >&2
	exit "${status}"
fi
if "${NPM_BIN}" access get status "${PKG_NAME}" --json --registry "${REGISTRY}" >"${access_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read package access\n' >&2
	exit "${status}"
fi
if "${NPM_BIN}" trust list "${PKG_NAME}" --json --registry "${REGISTRY}" >"${trust_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read trusted publishing\n' >&2
	exit "${status}"
fi
if "${GH_BIN}" api "repos/${REPO}/environments/${ENVIRONMENT}" >"${environment_file}" 2>/dev/null &&
	"${GH_BIN}" api "repos/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies" >"${policies_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read GitHub release environment\n' >&2
	exit "${status}"
fi
if ruleset_id="$("${GH_BIN}" api "repos/${REPO}/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\" and .source_type == \"Repository\") | .id" 2>/dev/null)"; then
	[[ "${ruleset_id}" =~ ^[1-9][0-9]*$ ]] || fail 'GitHub release ruleset was not found'
else
	status=$?
	printf 'error: unable to locate GitHub release ruleset\n' >&2
	exit "${status}"
fi
if "${GH_BIN}" api "repos/${REPO}/rulesets/${ruleset_id}" >"${ruleset_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read GitHub release ruleset\n' >&2
	exit "${status}"
fi

"${NODE_BIN}" --input-type=module - \
	"${metadata_file}" "${access_file}" "${trust_file}" \
	"${environment_file}" "${policies_file}" "${ruleset_file}" \
	"${PKG_NAME}" "${PKG_VERSION}" "${REPO}" "${WORKFLOW_FILE}" "${ENVIRONMENT}" \
	"${REVIEWER}" "${TAG_PATTERN}" "${RULESET_NAME}" <<'NODE'
import fs from "node:fs";

const [
  metadataPath, accessPath, trustPath, environmentPath, policiesPath, rulesetPath,
  packageName, packageVersion, repository, workflow, environment, reviewer, tagPattern, rulesetName,
] = process.argv.slice(2);
const reject = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
const readJson = (path, label) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    reject(`${label} returned invalid JSON`);
  }
};
const collectStrings = (value, output = []) => {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
};

const metadata = readJson(metadataPath, "package metadata");
const access = readJson(accessPath, "package access");
const trust = readJson(trustPath, "trusted publishing");
const environmentState = readJson(environmentPath, "GitHub environment");
const policies = readJson(policiesPath, "GitHub deployment policies");
const ruleset = readJson(rulesetPath, "GitHub ruleset");
const repositoryUrl = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
const acceptedRepositories = new Set([
  `git+https://github.com/${repository}.git`,
  `https://github.com/${repository}.git`,
  `https://github.com/${repository}`,
  `git@github.com:${repository}.git`,
]);

if (metadata.name !== packageName) reject("registry package name does not match PKG_NAME");
if (metadata.version !== packageVersion) reject("registry version does not match PKG_VERSION");
if (!acceptedRepositories.has(repositoryUrl)) reject("registry repository does not match REPO");
if (!metadata.dist?.integrity || !metadata.dist?.shasum) reject("registry dist integrity or shasum is missing");
if (!collectStrings(access).includes("public")) reject("package is not public");
const trustConfigs = Array.isArray(trust) ? trust : [trust];
const expectedTrust = trustConfigs.find(
  (config) =>
    config?.type === "github" &&
    config.file === workflow &&
    config.repository === repository &&
    config.environment === environment,
);
if (!expectedTrust) reject("GitHub trusted publisher identity does not match expected values");
if (
  !Array.isArray(expectedTrust.permissions) ||
  expectedTrust.permissions.length !== 1 ||
  expectedTrust.permissions[0] !== "createPackage"
) {
  reject("trusted publisher must have publish-only createPackage permission");
}
if (environmentState.can_admins_bypass !== false) reject("GitHub environment permits administrator bypass");
if (environmentState.deployment_branch_policy?.custom_branch_policies !== true) {
  reject("GitHub environment lacks custom deployment policies");
}
const expectedReviewer = environmentState.reviewers?.find(
  (entry) => entry?.type === "User" && entry.reviewer?.login === reviewer,
);
if (!expectedReviewer) reject("GitHub environment reviewer does not match REVIEWER");
const expectedPolicy = policies.branch_policies?.find(
  (policy) => policy?.name === tagPattern && policy?.type === "tag",
);
if (!expectedPolicy) reject("GitHub deployment tag policy does not match TAG_PATTERN");
if (ruleset.name !== rulesetName || ruleset.target !== "tag" || ruleset.enforcement !== "active") {
  reject("GitHub release ruleset identity is invalid");
}
const includes = ruleset.conditions?.ref_name?.include;
if (!Array.isArray(includes) || includes.length !== 1 || includes[0] !== `refs/tags/${tagPattern}`) {
  reject("GitHub release ruleset tag pattern does not match TAG_PATTERN");
}
const ruleTypes = ruleset.rules?.map((rule) => rule?.type).sort();
if (JSON.stringify(ruleTypes) !== JSON.stringify(["creation", "deletion", "update"])) {
  reject("GitHub release ruleset must protect tag creation, update, and deletion");
}
const bypass = ruleset.bypass_actors;
if (
  !Array.isArray(bypass) || bypass.length !== 1 || bypass[0]?.actor_id !== 5 ||
  bypass[0]?.actor_type !== "RepositoryRole" || bypass[0]?.bypass_mode !== "always"
) {
  reject("GitHub release ruleset must restrict bypass to repository administrators");
}
NODE

printf 'verification passed: %s@%s\n' "${PKG_NAME}" "${PKG_VERSION}"
