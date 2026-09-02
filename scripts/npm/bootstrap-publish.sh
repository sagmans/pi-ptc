#!/usr/bin/env bash
# Exact identity and byte checks keep the one-time bootstrap narrower than routine publishing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='bootstrap-publish'
readonly REGISTRY='https://registry.npmjs.org'
readonly PKG_NAME="${PKG_NAME:-}"
readonly PKG_VERSION="${PKG_VERSION:-}"
readonly REPO="${REPO:-}"
readonly NPM_ACCOUNT="${NPM_ACCOUNT:-}"

validate_package_name "${PKG_NAME}"
validate_version "${PKG_VERSION}"
validate_repository "${REPO}"
validate_account "${NPM_ACCOUNT}"
[ "${PKG_NAME%%/*}" = "@${NPM_ACCOUNT}" ] || fail 'bootstrap supports only the authenticated user scope'
require_command "${NPM_BIN}"
require_command "${GIT_BIN}"
require_command "${NODE_BIN}"
validate_package_metadata "${PKG_NAME}" "${PKG_VERSION}" "${REPO}"
require_clean_worktree
require_confirmation "${ACTION}"
require_npm_version

authenticated_account="$("${NPM_BIN}" whoami "--registry=${REGISTRY}" 2>/dev/null)" || fail 'npm authentication check failed'
[ "${authenticated_account}" = "${NPM_ACCOUNT}" ] || fail "npm account must be ${NPM_ACCOUNT}"

artifact_root="$(mktemp -d)"
registry_error="$(mktemp)"
trap 'rm -rf -- "${artifact_root}"; rm -f -- "${registry_error}"' EXIT
if "${NPM_BIN}" view "${PKG_NAME}" name --json "--registry=${REGISTRY}" >/dev/null 2>"${registry_error}"; then
	fail 'package already exists; bootstrap publish is not allowed'
else
	registry_status=$?
	if [ "${registry_status}" -ne 1 ] || ! grep -q 'E404' "${registry_error}"; then
		printf 'error: unable to prove package absence for authenticated account\n' >&2
		exit "${registry_status}"
	fi
fi

pack_output="$("${NPM_BIN}" pack --pack-destination "${artifact_root}")" || fail 'npm pack failed'
tarball_name="$(printf '%s\n' "${pack_output}" | tail -n 1)"
readonly tarball="${artifact_root}/${tarball_name}"
[ -f "${tarball}" ] || fail 'npm pack did not produce one package tarball'
case "${tarball}" in *.tgz) ;; *) fail 'npm pack returned a non-tarball path' ;; esac

"${NPM_BIN}" run smoke -- --tarball "${tarball}" >/dev/null || fail 'exact package smoke failed'
"${NPM_BIN}" publish "${tarball}" --dry-run --access public "--registry=${REGISTRY}" >/dev/null ||
	fail 'exact package publish dry-run failed'
printf 'target package: %s@%s\n' "${PKG_NAME}" "${PKG_VERSION}"
run_interactive_mutation "${ACTION}" "${NPM_BIN}" publish "${tarball}" --access public "--registry=${REGISTRY}"
printf 'bootstrap publish completed\n'
