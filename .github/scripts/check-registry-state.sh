#!/usr/bin/env bash
#
# Copyright ScyllaDB, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

: "${DIST_TAG:?DIST_TAG is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${LOCAL_INTEGRITY:?LOCAL_INTEGRITY is required}"
: "${NPM_REGISTRY:?NPM_REGISTRY is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME is required}"
: "${PACKAGE_VERSION:?PACKAGE_VERSION is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

node scripts/check-dist-tag.mjs "$PACKAGE_VERSION"

view_json="${RUNNER_TEMP}/npm-view.json"
view_error="${RUNNER_TEMP}/npm-view-error.log"

set +e
npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" dist.integrity --json \
  --registry "$NPM_REGISTRY" > "$view_json" 2> "$view_error"
view_status=$?
set -e

if [[ $view_status -eq 0 ]]; then
  remote_integrity=$(VIEW_JSON="$view_json" node --input-type=module <<'JS'
import { readFileSync } from "node:fs";

const integrity = JSON.parse(readFileSync(process.env.VIEW_JSON, "utf8"));
if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
  throw new Error("registry returned invalid package integrity");
}
process.stdout.write(integrity);
JS
  )

  if [[ "$remote_integrity" != "$LOCAL_INTEGRITY" ]]; then
    echo "${PACKAGE_NAME}@${PACKAGE_VERSION} already exists with different integrity."
    echo "Local:  $LOCAL_INTEGRITY"
    echo "Remote: $remote_integrity"
    exit 1
  fi

  echo "${PACKAGE_NAME}@${PACKAGE_VERSION} already exists with matching integrity; publish will be skipped."
  echo "publish_needed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

if ! grep -Eq 'E404|404 Not Found' "$view_error" "$view_json"; then
  cat "$view_error" >&2
  cat "$view_json" >&2
  exit "$view_status"
fi

tag_error="${RUNNER_TEMP}/npm-dist-tag-error.log"
set +e
current_version=$(npm view "$PACKAGE_NAME" "dist-tags.${DIST_TAG}" \
  --registry "$NPM_REGISTRY" 2> "$tag_error")
tag_status=$?
set -e

if [[ $tag_status -ne 0 ]]; then
  if grep -Eq 'E404|404 Not Found' "$tag_error"; then
    current_version=""
  else
    cat "$tag_error" >&2
    exit "$tag_status"
  fi
fi

node scripts/check-dist-tag.mjs "$PACKAGE_VERSION" "$current_version"
echo "publish_needed=true" >> "$GITHUB_OUTPUT"
