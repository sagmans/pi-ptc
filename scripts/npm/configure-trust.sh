#!/usr/bin/env bash
# Exact workflow identity prevents broader CI authority from becoming publish authority.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='configure-trust'
readonly REGISTRY='https://registry.npmjs.org'
readonly PKG_NAME="${PKG_NAME:-}"
readonly PKG_VERSION="${PKG_VERSION:-}"
readonly REPO="${REPO:-}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly NPM_ACCOUNT="${NPM_ACCOUNT:-}"

validate_package_name "${PKG_NAME}"
validate_version "${PKG_VERSION}"
validate_repository "${REPO}"
validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
validate_account "${NPM_ACCOUNT}"
require_workflow "${WORKFLOW_FILE}"
require_command "${NPM_BIN}"
require_command "${NODE_BIN}"
validate_package_metadata "${PKG_NAME}" "${PKG_VERSION}" "${REPO}"
require_confirmation "${ACTION}"
require_npm_version

authenticated_account="$("${NPM_BIN}" whoami "--registry=${REGISTRY}" 2>/dev/null)" || fail 'npm authentication check failed'
[ "${authenticated_account}" = "${NPM_ACCOUNT}" ] || fail "npm account must be ${NPM_ACCOUNT}"
run_interactive_mutation "${ACTION}" "${NPM_BIN}" trust github "${PKG_NAME}" \
	--file "${WORKFLOW_FILE}" --repo "${REPO}" --env "${ENVIRONMENT}" --allow-publish --yes
printf 'trusted publishing configured\n'
