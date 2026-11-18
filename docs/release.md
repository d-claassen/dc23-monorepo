# Releasing a plugin

Each plugin is released on its own, by hand, to its distribution repository `d-claassen/<slug>`. Sites install and update from there: Git Updater uses the release ZIP, Composer uses the git tag.

## How a release works

```
dc23-monorepo — "Release a plugin" workflow (manual)
  1. Checks      the CI checks and tests for <slug> on main
  2. Version     npm version <increment> in plugins/<slug> (header, readme.txt, package.json)
  3. Build       tools/build-plugin.mjs → dist/<slug>/ (distribution tree) + dist/<slug>.zip
  4. Monorepo    commit "Release <slug> X.Y.Z" + tag <slug>@X.Y.Z pushed to main
  5. Publish     tools/publish-plugin.mjs:
                   a. commit dist/<slug>/ on top of d-claassen/<slug> main, push it as tag vX.Y.Z only
                   b. wait for d-claassen/<slug>'s Release workflow (below), check the release ZIP
                   c. fast-forward d-claassen/<slug> main to vX.Y.Z

d-claassen/<slug> — "Release" workflow (on tag vX.Y.Z)
  checks header and readme.txt against the tag, adds the production autoloader (vendor/),
  zips everything except composer.json and .github/ as <slug>.zip, creates release vX.Y.Z
```

Git Updater reads the version from the plugin header on `main` of the distribution repository and downloads the ZIP of the newest release. Moving `main` last means a site never sees a version whose ZIP does not exist yet.

The distribution repository's workflow comes from `templates/release-workflow/release.yml`. It is added to every release commit, so change it there, never in a distribution repository.

## One-time setup

1. **Token.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   * Repository access: **Only select repositories** → the distribution repositories (not the monorepo).
   * Permissions: **Contents: Read and write**, **Workflows: Read and write** (the release commit contains `.github/workflows/release.yml`), **Actions: Read** (to follow the release run).
   * Expiration: your choice. Write the date down below.
2. **Secret.** In `d-claassen/dc23-monorepo` → Settings → Environments → **release** (create it if needed) → add secret `DIST_REPOS_TOKEN`. Optionally add yourself as a required reviewer, so every real release waits for your approval.
3. **Distribution repository.** Actions must be enabled. Its `main` must not be protected against pushes from the token.

Token expires: _not set yet_.

## Releasing

Actions → **Release a plugin** → Run workflow, from `main`:

| Input | Value |
|---|---|
| plugin | the directory name, e.g. `dc23-portfolio` |
| increment | `patch`, `minor` or `major`; `none` re-publishes the current version (recovery) |
| publish | leave **unticked** first: a dry run builds everything and shows what would change, without pushing anything |

Then run it again with **publish** ticked.

## What can go wrong, and how to recover

Every step checks what already exists, so re-running is safe. A release is never overwritten.

| Failure | State afterwards | Recovery |
|---|---|---|
| Checks or build fail | Nothing pushed | Fix on `main`, run again. |
| Pushing to the monorepo fails (main moved during the run) | Nothing pushed | Run again. |
| Publishing fails after the monorepo push (token, network) | Monorepo has `<slug>@X.Y.Z`; distribution repository unchanged, or only has tag `vX.Y.Z` | Fix the cause, run again with **increment `none`** and publish ticked. An existing `vX.Y.Z` with the same files is reused. |
| The distribution repository's Release workflow fails | Tag `vX.Y.Z` without a (complete) release; `main` not moved; sites see nothing | Fix the cause. Re-run that workflow (or start it by hand with the tag), then run **Release a plugin** with increment `none` to check the ZIP and move `main`. |
| `vX.Y.Z` exists with different files | Publishing stops | Never reuse a version: release with a new increment. |
| A released version is broken | Sites may have updated | Release a fixed version, or revert on `main` and release a new **higher** version. Git Updater and Composer only move forward; deleting a release does not downgrade sites. To hide a broken release from new installs, delete the release and tag in the distribution repository and move its `main` back to the previous release commit, so the header shows the previous version again. |

## Before the first release from the monorepo

The first release replaces the source files on `main` of the distribution repository with the built plugin (its history stays). From then on that repository is publish-only: develop in the monorepo, and do not release from the old workflows.
