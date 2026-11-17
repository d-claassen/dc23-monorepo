# DC23 WordPress plugins

Monorepo for the DC23 WordPress plugins. This repository is the canonical development source. Each plugin is published to its own repository, `d-claassen/<slug>`, from which sites install and update it (Git Updater, ZIP or Composer).

## Plugins

| Plugin | Directory | Distribution repository | Status |
|---|---|---|---|
| DC23 Portfolio | [`plugins/dc23-portfolio`](plugins/dc23-portfolio) | [d-claassen/dc23-portfolio](https://github.com/d-claassen/dc23-portfolio) | Developed here; releases from the monorepo are not set up yet |

The other plugins (`dc23-excessive-schema`, `dc23-reading-time`, `dc23-software-downloads`, `dc23-tea`) are still developed in their own repositories and move here later.

## Layout

```
plugins/<slug>/   One WordPress plugin per directory. <slug> is also the name of its distribution
                  repository, its ZIP, the folder inside the ZIP and its Composer package
                  (d-claassen/<slug>).
tools/            Scripts used locally and in CI (Node.js, no dependencies).
.github/          Workflows and Dependabot configuration for all plugins.
docs/             Development and release documentation.
dist/             Build output of tools/build-plugin.mjs (git-ignored).
```

Every plugin stays a complete, standalone plugin: its own `composer.json`, `package.json`, tests and `.wp-env.json`. Nothing in a plugin refers to files outside its directory.

## Common tasks

See [docs/development.md](docs/development.md) for details.

```sh
# Work on a plugin: everything runs inside its directory.
cd plugins/dc23-portfolio
npm ci && composer install
npm run build           # or: npm start
npm run wp-env start
npm run wp-env run -- --env-cwd=wp-content/plugins/dc23-portfolio tests-wordpress composer test

# From the repository root:
node tools/build-plugin.mjs dc23-portfolio    # distribution tree + installable ZIP in dist/
node tools/changed-plugins.mjs origin/main    # plugins affected by your branch
```
