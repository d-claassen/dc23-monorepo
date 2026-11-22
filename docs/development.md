# Development

## Requirements

* Node.js and npm (each plugin pins its version in `plugins/<slug>/.nvmrc`).
* PHP and Composer.
* Docker, for `wp-env`.

## Working on a plugin

All plugin commands run inside the plugin directory, exactly as they did in the plugin's own repository:

```sh
cd plugins/<slug>
npm ci
composer install
npm run build            # production build of the blocks into build/
npm start                # rebuild on change
npm run wp-env start     # WordPress with this plugin at http://localhost:8888
```

Tests:

```sh
npm run wp-env run -- --env-cwd=wp-content/plugins/<slug> tests-wordpress composer test
npm run test:e2e         # Playwright, where the plugin has specs
composer phplint
composer phpcs
npm run lint:js
npm run lint:css
```

The `--env-cwd` path ends in the directory name. wp-env names the plugin folder after the directory, which is why plugin directories are named exactly after the plugin slug.

## Building a plugin

```sh
node tools/build-plugin.mjs <slug>              # runs npm ci and npm run build first
node tools/build-plugin.mjs <slug> --skip-npm   # when build/ is already up to date
```

This produces two things in `dist/`:

| Output | Contents | Used for |
|---|---|---|
| `dist/<slug>/` | The plugin files selected by its `package.json#files`, plus what the distribution repository needs to publish releases. **No `vendor/`.** | The distribution repository `d-claassen/<slug>`, which Composer installs from. |
| `dist/<slug>.zip` | The installable plugin, **including its own autoloader**. | Git Updater and manual installation. |

The build stops when the result would reach sites broken or with an inconsistent version.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

1. **Affected plugins** – `tools/changed-plugins.mjs` lists the plugins changed since the base commit, plus plugins that depend on them (from `composer.json`). A change outside `plugins/` affects every plugin.
2. **Quality Control** (per affected plugin) – lint, coding standards, build, `tools/build-plugin.mjs`; uploads the ZIP and the distribution tree as artifacts.
3. **PHPUnit** (per affected plugin × PHP/WordPress versions) – runs the plugin's tests in wp-env.

CI never publishes or releases anything.

The workflows expect each plugin to provide these scripts: `composer phplint`, `composer phpcs`, `composer test`, and `npm run build`, `lint:pkg-json`, `lint:js`, `lint:css`, `packages-update`, `wp-env`.

## Adding blocks

Run the **Create a new block** workflow with the plugin directory name, or locally:

```sh
cd plugins/<slug>/src
npx @wordpress/create-block@latest <block> --namespace <slug> --no-plugin --variant dynamic
```

## Releases

See [release.md](release.md). Plugins that live here are released only from the monorepo, never from their old repository's workflows.
