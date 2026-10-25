# Releasing

This runbook is for maintainers publishing
`@scylladb/alternator-client`. Releases are built, tested, and published by the
`Release package` GitHub Actions workflow. Manual workflow runs are validation
only; only a protected `v*` tag can publish.

## One-time repository setup

Before the first release, verify these controls:

- `main` requires pull requests, successful Node.js 22 and 24 CI checks, and
  resolved review conversations; force pushes and deletion are blocked.
- `v*` tags can be created only by the designated maintainers and cannot be
  updated or deleted outside documented administrator recovery.
- Default GitHub Actions permissions are read-only. The release job alone has
  `contents: write` and `id-token: write`.
- GitHub private vulnerability reporting is enabled for the repository.

The initial npm publication needs a one-day granular npm access token with
read/write access to the `@scylladb` scope and bypass-2FA enabled. Store it as the
repository Actions secret `NPM_TOKEN`. Do not use a long-lived automation token.

After the first publication:

1. Configure an npm trusted publisher for repository
   `scylladb/alternator-client-javascript` and workflow file `release.yml`, with
   no GitHub Environment restriction. In **Allowed actions**, enable direct
   publishing with `npm publish`; staged publishing alone is insufficient for
   this workflow.
2. Require trusted publishing for the package so traditional access tokens
   cannot publish.
3. Delete the `NPM_TOKEN` repository secret from GitHub and revoke the temporary
   token on npm.

The workflow uses npm 11.19.1. When `NPM_TOKEN` is absent, publication uses
GitHub's OpenID Connect identity and npm trusted publishing.

## Prepare the release

All intended release changes must be merged before selecting the release
commit. Choose the release version (for example, `1.0.0`) and use it wherever
`<version>` appears below. Prepare the version and release notes through a
normal pull request:

1. Set `version` to `<version>` in both `package.json` and `package-lock.json`.
2. Complete `CHANGELOG.md` and `release-notes/v<version>.md`.
3. Verify the documented Node.js and ScyllaDB compatibility statements.
4. Run the complete local gate from a clean checkout:

   ```sh
   npm ci
   npm run verify
   make test-all
   ```

5. Merge the release-readiness pull request after all required checks pass.

Do not publish from a workstation and do not create a GitHub Release manually.
The publish job creates one release artifact, tests that exact tarball,
publishes it to npm, verifies the registry artifact, and only then creates the
GitHub Release.

## Validate and tag

Fetch the final protected branch and record its exact commit:

```sh
git fetch origin main --tags
release_sha=$(git rev-parse origin/main)
release_version=1.0.0 # Replace for each release.
release_tag="v${release_version}"
git show --stat "$release_sha"
```

Keep these variables in the same shell through tag creation.

From the Actions UI, run `Release package` on `main` using
`workflow_dispatch`. The manual run performs the release gates but cannot
publish. It also checks the candidate artifact against the existing npm version
and selected dist-tag. Confirm the run for `release_sha` succeeds; if `main`
moves during the run, validate the newer commit or tag the exact commit already
validated.

Create a signed annotated tag for the validated commit and push only that tag:

```sh
git tag -s "$release_tag" "$release_sha" -m "@scylladb/alternator-client ${release_tag}"
git push origin "refs/tags/${release_tag}"
```

The tag-triggered workflow rejects the release unless all of these invariants
hold:

- the tag is exactly `v${package.version}`;
- the tagged commit is contained in `origin/main`;
- `release-notes/v<version>.md` exists;
- if the npm version is unpublished, publishing it creates or advances the npm
  dist-tag selected for the release;
- the npm version is unpublished, or its registry integrity matches the exact
  local tarball.

For a stable version, publication uses the npm `latest` dist-tag. A SemVer
prerelease uses `next`.

## Verify publication

Watch the tag-triggered `Release package` workflow through completion. It must:

1. pass type, lint, unit, package, audit, and integration gates;
2. remove old build output, create the release artifact once, and test that exact
   tarball;
3. publish that tarball to npm with provenance;
4. wait until npm reports matching artifact integrity;
5. install the exact registry version and repeat the package smoke test;
6. create the GitHub Release, or publish a matching draft, with curated
   `release-notes/v<version>.md` followed by filtered GitHub generated notes.
   A rerun leaves an already published release and its notes unchanged.

After the workflow succeeds, verify the public state:

```sh
release_version=1.0.0 # Use the version selected above.
npm view "@scylladb/alternator-client@${release_version}" version dist.integrity dist-tags --json
```

Confirm npm displays the README, Apache-2.0 license, provenance, and the expected
`latest` or `next` dist-tag. Confirm the `v<version>` GitHub Release exists and
points to the validated commit.

## Recovery

If a failure happens before npm accepts the package, first confirm that npm has
no published version and no GitHub Release was created. An administrator may
then delete the failed protected tag using break-glass access. Fix the cause on
`main`, repeat validation, and recreate the tag on the newly validated commit.

If npm accepted the package, never move the tag, delete the release to reuse the
version, or publish a different artifact as the release version. Rerun the tag
workflow. A rerun detects matching registry integrity, skips npm publication,
repeats registry verification, and creates the GitHub Release if it is missing.

If npm contains the release version with different integrity, stop the release.
Investigate the discrepancy and prepare a new patch version; npm versions are
immutable.

## Release note classification

The `Classify release notes` workflow uses `actions/labeler` with the filename
rules in `.github/labeler.yml` to manage `omit-from-release-notes`. Every changed
filename, including a rename's previous filename, must match the union of
documentation, tests, explicitly listed CI configuration and development helpers.
Production code, root dependency manifests, build/packaging inputs, production
release workflows and unknown paths remain visible. The explicitly listed private
automation manifests under `.github/` are eligible. README and other listed
documentation qualify even when included in the npm package.

`sync-labels: true` removes the label when changed filenames stop matching.
The workflow runs on PR opens, updates, edits, reopens, and closes, including
merges. A guard validates complete file metadata and compares the PR revisions and
file listing before and after classification. It also verifies the actual omission
label, including its case-insensitive logical name. Production-origin renames skip
the action and remove the omission label. Failed or unexpectedly skipped
classification attempts omission-label cleanup and leaves a visible workflow
failure. Cleanup is best effort: API outages can prevent it, and before/after reads
do not make classification atomic or race-free.

The workflow confirms the target is a pull request before checking out trusted
workflow code or installing its isolated dependencies. An ordinary issue or an
unconfirmed target receives no label writes. Once confirmed, a PR retains cleanup
after later setup or API failures. Run manual dispatch on the default branch.

Before pushing a release tag, identify the merged PRs included since the previous
release. For each PR, run `Classify release notes` from the Actions UI on the default
branch with its PR number. Wait for a successful run, check its verified revision
and file-snapshot output, and inspect the actual PR labels and changed paths.
Confirm support-only changes carry the omission label and runtime, build and mixed
changes do not. On a failed run or changed PR evidence, rerun classification and
repeat inspection before tagging. Review curated notes separately.

Release publication remains asynchronous; there is no automated classification
barrier. Missed manual verification can leave omissions or unwanted support entries
in published notes. Published releases are not synchronized automatically. Generated
notes use `.github/release.yml` to
exclude labeled PRs; labels alone do not edit the curated notes. Keep curated
notes focused on release guidance and user-facing changes, and remove any
support-only PR references from that hand-maintained text during release review.
New releases and matching drafts receive the curated file and generated section.
Matching-draft recovery inspects every release-list page. Reruns preserve already
published notes, including any earlier classification mistake. No exclusion
is based solely on author, PR title, or broad dependency/housekeeping labels.

Run the focused automation tests with `node --test scripts/github-release-notes.test.mjs`
and `npm ci --ignore-scripts --prefix .github && node --test .github/tests/release-notes-guard.test.cjs`.
