#!/usr/bin/env node
/**
 * Builds the distributable form of one plugin.
 *
 * Usage:
 *   node tools/build-plugin.mjs <slug> [--skip-npm]
 *
 * Output (in dist/, git-ignored):
 *   dist/<slug>/      Distribution tree: what the dedicated repository d-claassen/<slug> will contain.
 *                     Plugin files + build/ + a cleaned composer.json + the release workflow from
 *                     templates/release-workflow/, with the .gitattributes from there that keeps that
 *                     workflow out of git archives (and so out of Composer installs). No vendor/: Composer consumers
 *                     generate their own autoloader.
 *   dist/<slug>.zip   Installable plugin ZIP (root folder <slug>/): the distribution tree without
 *                     composer.json, plus vendor/ with the production autoloader. Same shape as the
 *                     release asset that Git Updater installs.
 *
 * Steps:
 *   1. npm ci + npm run build in plugins/<slug> (skipped with --skip-npm, e.g. when CI already built).
 *   2. Select files with `npm pack --dry-run` (package.json#files), like `wp-scripts plugin-zip` does.
 *   3. Install the production autoloader in a staging copy, so the plugin's own dev vendor/ is untouched.
 *   4. Validate both outputs and fail loudly on anything unexpected.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve( dirname( new URL( import.meta.url ).pathname ), '..' );
const [ slug, ...flags ] = process.argv.slice( 2 );

if ( ! slug || slug.startsWith( '-' ) ) {
	fail( 'Usage: node tools/build-plugin.mjs <slug> [--skip-npm]' );
}

const pluginDir = join( ROOT, 'plugins', slug );
const distDir = join( ROOT, 'dist' );
const treeDir = join( distDir, slug );
const zipStage = join( distDir, '.zip-stage', slug );
const zipFile = join( distDir, `${ slug }.zip` );
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const GITATTRIBUTES = readFileSync( join( ROOT, 'templates', 'release-workflow', '.gitattributes' ), 'utf8' );

if ( ! existsSync( join( pluginDir, `${ slug }.php` ) ) ) {
	fail( `plugins/${ slug }/${ slug }.php not found: the main plugin file must be named after the slug.` );
}

// 1. Frontend build.
const pkg = readJson( join( pluginDir, 'package.json' ) );
if ( pkg.name !== slug ) {
	fail( `package.json name is "${ pkg.name }", expected "${ slug }" (it determines the ZIP name).` );
}
if ( ! flags.includes( '--skip-npm' ) ) {
	run( 'npm', [ 'ci', '--no-audit', '--no-fund' ], pluginDir );
	if ( pkg.scripts?.build ) {
		run( 'npm', [ 'run', 'build' ], pluginDir );
	}
}

// 2. Files to ship, as selected by package.json#files. vendor/ is never taken from the plugin
//    directory, because it contains development dependencies there.
const packed = JSON.parse( run( 'npm', [ 'pack', '--dry-run', '--json', '--ignore-scripts' ], pluginDir, true ) );
const files = packed[ 0 ].files.map( ( file ) => file.path ).filter( ( path ) => ! path.startsWith( 'vendor/' ) );

rmSync( treeDir, { recursive: true, force: true } );
rmSync( join( distDir, '.zip-stage' ), { recursive: true, force: true } );
rmSync( zipFile, { force: true } );

for ( const file of files ) {
	copy( join( pluginDir, file ), join( treeDir, file ) );
	copy( join( pluginDir, file ), join( zipStage, file ) );
}

// 3. Production autoloader, built in a staging directory from the plugin's own composer files.
const composer = readJson( join( pluginDir, 'composer.json' ) );
const composerStage = join( distDir, '.composer-stage', slug );
rmSync( join( distDir, '.composer-stage' ), { recursive: true, force: true } );
mkdirSync( composerStage, { recursive: true } );
copy( join( pluginDir, 'composer.json' ), join( composerStage, 'composer.json' ) );
for ( const autoloadPath of autoloadPaths( composer ) ) {
	copy( join( pluginDir, autoloadPath ), join( composerStage, autoloadPath ) );
}
const composerArgs = [ '--no-dev', '--optimize-autoloader', '--no-interaction', '--no-scripts', '--no-plugins' ];
if ( existsSync( join( pluginDir, 'composer.lock' ) ) ) {
	copy( join( pluginDir, 'composer.lock' ), join( composerStage, 'composer.lock' ) );
	run( 'composer', [ 'install', '--no-progress', ...composerArgs ], composerStage );
} else {
	// Without a lock file, `install` would resolve require-dev too. A plugin without production
	// dependencies only needs the autoloader, which dump-autoload generates without resolving.
	if ( Object.keys( composer.require ?? {} ).some( ( name ) => name !== 'php' && ! name.startsWith( 'ext-' ) ) ) {
		fail( 'composer.json has production dependencies but no composer.lock.' );
	}
	run( 'composer', [ 'dump-autoload', '--no-dev', '--optimize', '--no-interaction', '--no-scripts', '--no-plugins' ], composerStage );
}
cpSync( join( composerStage, 'vendor' ), join( zipStage, 'vendor' ), { recursive: true } );
rmSync( join( distDir, '.composer-stage' ), { recursive: true, force: true } );

// The distribution tree gets a composer.json without development-only and monorepo-only keys.
writeFileSync( join( treeDir, 'composer.json' ), JSON.stringify( cleanComposer( composer ), null, '\t' ) + '\n' );

// The distribution repository creates its own GitHub release from a tag, with the shared workflow.
copy( join( ROOT, 'templates', 'release-workflow', 'release.yml' ), join( treeDir, RELEASE_WORKFLOW ) );
copy( join( ROOT, 'templates', 'release-workflow', '.gitattributes' ), join( treeDir, '.gitattributes' ) );

// 4. Validate, then zip.
validate( treeDir, { expectVendor: false, expectComposer: true } );
validate( zipStage, { expectVendor: true, expectComposer: false } );
run( 'zip', [ '-r', '-q', '-X', zipFile, slug ], join( distDir, '.zip-stage' ) );
rmSync( join( distDir, '.zip-stage' ), { recursive: true, force: true } );

console.log( `\nBuilt ${ slug } ${ headerVersion( treeDir ) }` );
console.log( `  tree: ${ relative( treeDir ) } (${ countFiles( treeDir ) } files)` );
console.log( `  zip:  ${ relative( zipFile ) }` );

// ---------------------------------------------------------------------------------------------

function cleanComposer( source ) {
	const keep = [ 'name', 'description', 'type', 'keywords', 'homepage', 'license', 'authors', 'support', 'require', 'suggest', 'conflict', 'autoload' ];
	return Object.fromEntries( keep.filter( ( key ) => key in source ).map( ( key ) => [ key, source[ key ] ] ) );
}

function autoloadPaths( source ) {
	const autoload = source.autoload ?? {};
	return [
		...Object.values( autoload[ 'psr-4' ] ?? {} ).flat(),
		...Object.values( autoload[ 'psr-0' ] ?? {} ).flat(),
		...( autoload.classmap ?? [] ),
		...( autoload.files ?? [] ),
	].filter( ( path ) => existsSync( join( pluginDir, path ) ) );
}

function validate( dir, { expectVendor, expectComposer } ) {
	const where = relative( dir );
	const version = headerVersion( dir );
	if ( version !== pkg.version ) {
		fail( `${ where }: plugin header Version ${ version } does not match package.json version ${ pkg.version }.` );
	}
	const readme = readFileSync( join( dir, 'readme.txt' ), 'utf8' ).match( /^Stable tag:\s*(\S+)/m )?.[ 1 ];
	if ( readme !== pkg.version ) {
		fail( `${ where }: readme.txt Stable tag ${ readme } does not match package.json version ${ pkg.version }.` );
	}
	if ( existsSync( join( pluginDir, 'webpack.config.js' ) ) || pkg.scripts?.build ) {
		if ( ! existsSync( join( dir, 'build' ) ) ) {
			fail( `${ where }: build/ is missing; run the frontend build first.` );
		}
	}
	if ( existsSync( join( dir, 'vendor' ) ) !== expectVendor ) {
		fail( `${ where }: vendor/ ${ expectVendor ? 'missing' : 'must not be present' }.` );
	}
	if ( expectVendor && ! existsSync( join( dir, 'vendor', 'autoload.php' ) ) ) {
		fail( `${ where }: vendor/autoload.php missing.` );
	}
	if ( existsSync( join( dir, 'composer.json' ) ) !== expectComposer ) {
		fail( `${ where }: composer.json ${ expectComposer ? 'missing' : 'must not be present' }.` );
	}
	// The distribution tree contains exactly one file in .github/: the release workflow. The ZIP none.
	if ( existsSync( join( dir, '.github' ) ) ) {
		const githubFiles = readdirSync( join( dir, '.github' ), { recursive: true, withFileTypes: true } )
			.filter( ( entry ) => entry.isFile() )
			.map( ( entry ) => join( entry.parentPath ?? entry.path, entry.name ).slice( dir.length + 1 ) );
		if ( expectVendor || githubFiles.join() !== RELEASE_WORKFLOW ) {
			fail( `${ where }: unexpected files in .github/: ${ githubFiles.join( ', ' ) }.` );
		}
	} else if ( ! expectVendor ) {
		fail( `${ where }: ${ RELEASE_WORKFLOW } missing.` );
	}
	// The distribution tree has the .gitattributes from the template, the ZIP does not.
	const attributes = join( dir, '.gitattributes' );
	if ( expectVendor ? existsSync( attributes ) : ! existsSync( attributes ) || readFileSync( attributes, 'utf8' ) !== GITATTRIBUTES ) {
		fail( `${ where }: .gitattributes ${ expectVendor ? 'must not be shipped' : 'missing or different from templates/release-workflow/.gitattributes' }.` );
	}
	const forbidden = [ 'node_modules', 'tests', 'specs', '.wp-env.json', 'phpunit.xml.dist', 'composer.lock', 'package-lock.json' ];
	for ( const path of forbidden ) {
		if ( existsSync( join( dir, path ) ) ) {
			fail( `${ where }: development file ${ path } must not be shipped.` );
		}
	}
	if ( expectVendor ) {
		const packages = readdirSync( join( dir, 'vendor' ) ).filter( ( name ) => ! [ 'autoload.php', 'composer' ].includes( name ) );
		const required = Object.keys( composer.require ?? {} ).filter( ( name ) => name !== 'php' && ! name.startsWith( 'ext-' ) );
		if ( required.length === 0 && packages.length > 0 ) {
			fail( `${ where }: vendor/ contains ${ packages.join( ', ' ) } but the plugin has no production dependencies.` );
		}
	}
}

function headerVersion( dir ) {
	return readFileSync( join( dir, `${ slug }.php` ), 'utf8' ).match( /^\s*\*\s*Version:\s*(\S+)/m )?.[ 1 ];
}

function countFiles( dir ) {
	return readdirSync( dir, { recursive: true, withFileTypes: true } ).filter( ( entry ) => entry.isFile() ).length;
}

function copy( from, to ) {
	mkdirSync( dirname( to ), { recursive: true } );
	cpSync( from, to, { recursive: true } );
}

function readJson( path ) {
	return JSON.parse( readFileSync( path, 'utf8' ) );
}

function relative( path ) {
	return path.slice( ROOT.length + 1 );
}

function run( command, args, cwd, capture = false ) {
	// COMPOSER_ROOT_VERSION makes Composer record the plugin version instead of the monorepo branch
	// in vendor/composer/installed.php, as a build in the plugin's own repository did.
	const env = { ...process.env, COMPOSER_ROOT_VERSION: pkg.version };
	// The npm pack listing includes the plugin's development vendor/ (thousands of files), so allow
	// far more output than the 1 MB default.
	return execFileSync( command, args, { cwd, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: capture ? [ 'ignore', 'pipe', 'inherit' ] : 'inherit' } );
}

function fail( message ) {
	console.error( `build-plugin: ${ message }` );
	process.exit( 1 );
}
