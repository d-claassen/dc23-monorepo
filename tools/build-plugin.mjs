#!/usr/bin/env node
/**
 * Builds a plugin into the two forms it is published in: the tree for its distribution
 * repository, and the installable ZIP.
 *
 * Usage: node tools/build-plugin.mjs <slug> [--skip-npm]
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

const pkg = readJson( join( pluginDir, 'package.json' ) );
if ( pkg.name !== slug ) {
	// Git Updater only accepts a ZIP named after the repository.
	fail( `package.json name is "${ pkg.name }", expected "${ slug }".` );
}
if ( ! flags.includes( '--skip-npm' ) ) {
	run( 'npm', [ 'ci', '--no-audit', '--no-fund' ], pluginDir );
	if ( pkg.scripts?.build ) {
		run( 'npm', [ 'run', 'build' ], pluginDir );
	}
}

// The plugin's package.json#files decides what is shipped. Its own vendor/ holds development
// dependencies, so the production autoloader is generated separately.
const packed = JSON.parse( run( 'npm', [ 'pack', '--dry-run', '--json', '--ignore-scripts' ], pluginDir, true ) );
const files = packed[ 0 ].files.map( ( file ) => file.path ).filter( ( path ) => ! path.startsWith( 'vendor/' ) );

for ( const path of [ treeDir, dirname( zipStage ), zipFile ] ) {
	rmSync( path, { recursive: true, force: true } );
}
for ( const file of files ) {
	copy( join( pluginDir, file ), join( treeDir, file ) );
	copy( join( pluginDir, file ), join( zipStage, file ) );
}

// The autoloader is generated the way the distribution repository does it for its release, next
// to the shipped files, so the ZIP built here is the ZIP sites will get.
const composer = readJson( join( pluginDir, 'composer.json' ) );
writeFileSync( join( zipStage, 'composer.json' ), JSON.stringify( publishedComposer( composer ) ) );
run( 'composer', [ 'install', '--no-dev', '--optimize-autoloader', '--no-interaction', '--no-progress', '--no-scripts', '--no-plugins' ], zipStage );
rmSync( join( zipStage, 'composer.json' ) );
rmSync( join( zipStage, 'composer.lock' ), { force: true } );

// The distribution repository is what Composer installs from, so it gets a composer.json without
// development settings, plus what it needs to publish its own releases.
writeFileSync( join( treeDir, 'composer.json' ), JSON.stringify( publishedComposer( composer ), null, '\t' ) + '\n' );
copy( join( ROOT, 'templates', 'release-workflow', 'release.yml' ), join( treeDir, '.github', 'workflows', 'release.yml' ) );
copy( join( ROOT, 'templates', 'release-workflow', '.gitattributes' ), join( treeDir, '.gitattributes' ) );

checkWhatSitesGet( zipStage );
run( 'zip', [ '-r', '-q', '-X', zipFile, slug ], dirname( zipStage ) );
rmSync( dirname( zipStage ), { recursive: true, force: true } );

console.log( `\nBuilt ${ slug } ${ pkg.version }: ${ relative( treeDir ) }/ and ${ relative( zipFile ) }` );

// ---------------------------------------------------------------------------------------------

function publishedComposer( source ) {
	const keep = [ 'name', 'description', 'type', 'keywords', 'homepage', 'license', 'authors', 'support', 'require', 'suggest', 'conflict', 'autoload' ];
	return Object.fromEntries( keep.filter( ( key ) => key in source ).map( ( key ) => [ key, source[ key ] ] ) );
}

/**
 * Stops a release that would reach sites broken, or announce a version it does not contain.
 */
function checkWhatSitesGet( dir ) {
	const main = readFileSync( join( dir, `${ slug }.php` ), 'utf8' );
	const readme = readFileSync( join( dir, 'readme.txt' ), 'utf8' );
	const header = main.match( /^\s*\*\s*Version:\s*(\S+)/m )?.[ 1 ];
	const stable = readme.match( /^Stable tag:\s*(\S+)/m )?.[ 1 ];
	if ( header !== pkg.version || stable !== pkg.version ) {
		fail( `versions differ: package.json ${ pkg.version }, plugin header ${ header }, readme.txt ${ stable }.` );
	}
	if ( pkg.scripts?.build && ! existsSync( join( dir, 'build' ) ) ) {
		fail( 'build/ is missing.' );
	}
	if ( ! existsSync( join( dir, 'vendor', 'autoload.php' ) ) ) {
		fail( 'vendor/autoload.php is missing.' );
	}
	const development = readdirSync( dir ).filter( ( name ) => /^(node_modules|tests?|specs|\..+|.*\.lock|package-lock\.json|phpunit\.xml.*)$/.test( name ) );
	if ( development.length ) {
		fail( `development files would be shipped: ${ development.join( ', ' ) }.` );
	}
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
	// COMPOSER_ROOT_VERSION records the plugin's version, not the monorepo branch, in the autoloader.
	const env = { ...process.env, COMPOSER_ROOT_VERSION: pkg.version };
	return execFileSync( command, args, { cwd, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: capture ? [ 'ignore', 'pipe', 'inherit' ] : 'inherit' } );
}

function fail( message ) {
	console.error( `build-plugin: ${ message }` );
	process.exit( 1 );
}
