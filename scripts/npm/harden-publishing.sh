#!/usr/bin/env bash
# Interactive account proof remains required while OIDC replaces reusable publish tokens.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='harden-publishing'
readonly REGISTRY='https://registry.npmjs.org'
readonly PKG_NAME="${PKG_NAME:-}"
readonly NPM_ACCOUNT="${NPM_ACCOUNT:-}"

validate_package_name "${PKG_NAME}"
validate_account "${NPM_ACCOUNT}"
require_command "${NPM_BIN}"
require_confirmation "${ACTION}"
require_npm_version

authenticated_account="$("${NPM_BIN}" whoami "--registry=${REGISTRY}" 2>/dev/null)" || fail 'npm authentication check failed'
[ "${authenticated_account}" = "${NPM_ACCOUNT}" ] || fail "npm account must be ${NPM_ACCOUNT}"
run_interactive_mutation "${ACTION}" "${NPM_BIN}" access set mfa=publish "${PKG_NAME}"
printf 'publishing hardened\n'
