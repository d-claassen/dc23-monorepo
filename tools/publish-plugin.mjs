#!/usr/bin/env node
/**
 * Publishes a built plugin to its distribution repository (d-claassen/<slug>).
 *
 * Usage:
 *   node tools/publish-plugin.mjs <slug> [--dry-run]
 *
 * Requires dist/<slug>/ and dist/<slug>.zip from tools/build-plugin.mjs.
 *
 * Environment:
 *   DIST_REPOS_TOKEN  Fine-grained token with Contents (read/write), Workflows (read/write) and
 *                     Actions (read) on the distribution repository. Not needed for --dry-run.
 *   DIST_REPO_URL     Override the repository URL (tests only). A local path skips the GitHub steps.
 *   MONOREPO_SHA      Monorepo commit the release is built from (default: git rev-parse HEAD).
 *
 * Steps, each safe to repeat:
 *   1. Commit dist/<slug>/ on top of the distribution repository's main, as tag vX.Y.Z only.
 *      An existing tag with the same files is reused; an existing tag with other files is an error.
 *   2. Wait for the distribution repository's Release workflow to create release vX.Y.Z with
 *      <slug>.zip, and check that this ZIP holds the same files as dist/<slug>.zip.
 *   3. Fast-forward the distribution repository's main to the tag. Only now do Git Updater sites
 *      see the new version, so they never get a version without its ZIP.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ROOT = resolve( dirname( new URL( import.meta.url ).pathname ), '..' );
const OWNER = 'd-claassen';
const MONOREPO = `${ OWNER }/dc23-monorepo`;
const WAIT_SECONDS = 15 * 60;

const [ slug, ...flags ] = process.argv.slice( 2 );
const dryRun = flags.includes( '--dry-run' );
if ( ! slug || slug.startsWith( '-' ) ) {
	fail( 'Usage: node tools/publish-plugin.mjs <slug> [--dry-run]' );
}

const treeDir = join( ROOT, 'dist', slug );
const zipFile = join( ROOT, 'dist', `${ slug }.zip` );
if ( ! existsSync( join( treeDir, `${ slug }.php` ) ) || ! existsSync( zipFile ) ) {
	fail( `dist/${ slug }/ or dist/${ slug }.zip missing: run tools/build-plugin.mjs ${ slug } first.` );
}

const version = readFileSync( join( treeDir, `${ slug }.php` ), 'utf8' ).match( /^\s*\*\s*Version:\s*(\S+)/m )?.[ 1 ];
const pluginName = readFileSync( join( treeDir, `${ slug }.php` ), 'utf8' ).match( /^\s*\*\s*Plugin Name:\s*(.+)$/m )?.[ 1 ].trim();
const tag = `v${ version }`;
const repo = `${ OWNER }/${ slug }`;
const repoUrl = process.env.DIST_REPO_URL ?? `https://github.com/${ repo }.git`;
const isLocal = isAbsolute( repoUrl ) || repoUrl.startsWith( 'file:' );
const token = process.env.DIST_REPOS_TOKEN;
const monorepoSha = process.env.MONOREPO_SHA ?? git( [ 'rev-parse', 'HEAD' ], ROOT );

if ( ! dryRun && ! isLocal && ! token ) {
	fail( 'DIST_REPOS_TOKEN is not set.' );
}

log( `${ dryRun ? 'Dry run: ' : '' }publishing ${ slug } ${ version } to ${ isLocal ? repoUrl : repo }` );

// --- 1. Release commit and tag ---------------------------------------------------------------

const work = mkdtempSync( join( tmpdir(), `publish-${ slug }-` ) );
process.on( 'exit', () => rmSync( work, { recursive: true, force: true } ) );

git( [ 'init', '-q', '-b', 'main' ], work );
git( [ 'remote', 'add', 'origin', repoUrl ], work );
git( [ 'fetch', '-q', '--depth=1', 'origin', 'refs/heads/main:refs/remotes/origin/main' ], work );
const mainSha = git( [ 'rev-parse', 'refs/remotes/origin/main' ], work );

// The tree the release commit must have: exactly the distribution tree.
git( [ 'checkout', '-q', '-b', 'release', 'refs/remotes/origin/main' ], work );
git( [ 'rm', '-r', '-q', '--ignore-unmatch', '.' ], work );
for ( const entry of readdirSync( treeDir ) ) {
	cpSync( join( treeDir, entry ), join( work, entry ), { recursive: true } );
}
git( [ 'add', '-A', '--force', '.' ], work );
const wantedTree = git( [ 'write-tree' ], work );
const changes = git( [ 'diff', '--cached', '--name-status', 'refs/remotes/origin/main' ], work ).split( '\n' ).filter( Boolean );
log( `Compared with ${ repo } main (${ mainSha.slice( 0, 7 ) }): ${ summarize( changes ) }` );

const remoteTag = git( [ 'ls-remote', '--tags', 'origin', `refs/tags/${ tag }` ], work );
let releaseSha;

if ( remoteTag ) {
	git( [ 'fetch', '-q', '--depth=1', 'origin', `refs/tags/${ tag }:refs/tags/${ tag }` ], work );
	releaseSha = git( [ 'rev-parse', `${ tag }^{commit}` ], work );
	const tagTree = git( [ 'rev-parse', `${ tag }^{tree}` ], work );
	if ( tagTree !== wantedTree ) {
		fail( `${ tag } already exists in ${ repo } with different files. Releases are never overwritten; bump the version instead.` );
	}
	log( `${ tag } already exists with the same files (${ releaseSha.slice( 0, 7 ) }); continuing with it.` );
} else {
	const notes = [
		`${ pluginName } ${ version }`,
		'',
		`Built from ${ MONOREPO }@${ monorepoSha } (plugins/${ slug }).`,
		`Changes: https://github.com/${ MONOREPO }/commits/${ monorepoSha }/plugins/${ slug }`,
	].join( '\n' );
	git( [ 'commit', '-q', '--allow-empty', '-m', `Release ${ version }`, '-m', notes.split( '\n' ).slice( 2 ).join( '\n' ) ], work );
	git( [ 'tag', '-a', tag, '-m', notes ], work );
	releaseSha = git( [ 'rev-parse', 'HEAD' ], work );
	if ( dryRun ) {
		log( `Dry run: would push tag ${ tag } (${ releaseSha.slice( 0, 7 ) }) and nothing else.` );
	} else {
		git( [ 'push', '-q', 'origin', `refs/tags/${ tag }` ], work );
		log( `Pushed tag ${ tag } (${ releaseSha.slice( 0, 7 ) }).` );
	}
}

// --- 2. Release and ZIP in the distribution repository -----------------------------------------

if ( dryRun ) {
	log( 'Dry run: skipping the release check and the main update.' );
	process.exit( 0 );
}
if ( isLocal ) {
	log( 'Local repository: no GitHub release to wait for.' );
} else {
	await waitForReleaseWorkflow( releaseSha );
	await checkReleaseAsset();
}

// --- 3. Move main ------------------------------------------------------------------------------

const currentMain = git( [ 'ls-remote', 'origin', 'refs/heads/main' ], work ).split( /\s+/ )[ 0 ];
if ( currentMain === releaseSha ) {
	log( `main already points to ${ tag }.` );
} else if ( parentOf( releaseSha ) === currentMain ) {
	git( [ 'push', '-q', 'origin', `${ releaseSha }:refs/heads/main` ], work );
	log( `Moved ${ repo } main to ${ tag } (${ releaseSha.slice( 0, 7 ) }).` );
} else {
	fail( `main of ${ repo } (${ currentMain.slice( 0, 7 ) }) is not the parent of ${ tag }; it changed since the release commit was made. Not moving it.` );
}

log( `Done: ${ slug } ${ version } is published.` );

// ---------------------------------------------------------------------------------------------

async function waitForReleaseWorkflow( sha ) {
	const deadline = Date.now() + WAIT_SECONDS * 1000;
	log( `Waiting for the Release workflow in ${ repo } …` );
	while ( Date.now() < deadline ) {
		const runs = ( await api( `/repos/${ repo }/actions/runs?head_sha=${ sha }&per_page=20` ) ).workflow_runs
			.filter( ( run ) => run.name === 'Release' );
		const run = runs.sort( ( a, b ) => b.run_number - a.run_number )[ 0 ];
		if ( run?.status === 'completed' ) {
			if ( run.conclusion !== 'success' ) {
				fail( `The Release workflow in ${ repo } ended with "${ run.conclusion }": ${ run.html_url }. main was not moved.` );
			}
			log( `Release workflow succeeded: ${ run.html_url }` );
			return;
		}
		await new Promise( ( done ) => setTimeout( done, 15000 ) );
	}
	fail( `No finished Release workflow in ${ repo } for ${ sha.slice( 0, 7 ) } after ${ WAIT_SECONDS / 60 } minutes. main was not moved.` );
}

async function checkReleaseAsset() {
	const release = await api( `/repos/${ repo }/releases/tags/${ tag }` );
	const asset = release.assets.find( ( item ) => item.name === `${ slug }.zip` );
	if ( ! asset ) {
		fail( `Release ${ tag } has no ${ slug }.zip. main was not moved.` );
	}
	const response = await fetch( asset.url, { headers: { ...headers(), Accept: 'application/octet-stream' } } );
	if ( ! response.ok ) {
		fail( `Downloading ${ slug }.zip failed: HTTP ${ response.status }.` );
	}
	const downloaded = join( work, 'released.zip' );
	writeFileSync( downloaded, Buffer.from( await response.arrayBuffer() ) );
	const listing = ( file ) => execFileSync( 'unzip', [ '-Z1', file ], { encoding: 'utf8' } ).split( '\n' ).filter( ( line ) => line && ! line.endsWith( '/' ) ).sort().join( '\n' );
	if ( listing( downloaded ) !== listing( zipFile ) ) {
		fail( `The released ${ slug }.zip does not contain the same files as dist/${ slug }.zip. main was not moved.` );
	}
	log( `Release ${ tag } has ${ slug }.zip (${ asset.size } bytes) with the expected files: ${ release.html_url }` );
}

async function api( path ) {
	const response = await fetch( `https://api.github.com${ path }`, { headers: headers() } );
	if ( ! response.ok ) {
		fail( `GitHub API ${ path }: HTTP ${ response.status }` );
	}
	return response.json();
}

function headers() {
	return { Authorization: `Bearer ${ token }`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function parentOf( sha ) {
	return git( [ 'cat-file', '-p', sha ], work ).match( /^parent (\S+)/m )?.[ 1 ];
}

function summarize( lines ) {
	const counts = { A: 0, M: 0, D: 0 };
	for ( const line of lines ) {
		counts[ line[ 0 ] ] = ( counts[ line[ 0 ] ] ?? 0 ) + 1;
	}
	return `${ counts.A } added, ${ counts.M } modified, ${ counts.D } deleted`;
}

function git( args, cwd ) {
	const auth = token && ! isLocal
		? [ '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${ Buffer.from( `x-access-token:${ token }` ).toString( 'base64' ) }` ]
		: [];
	return execFileSync( 'git', [ ...auth, ...args ], { cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } ).trim();
}

function log( message ) {
	console.log( message );
}

function fail( message ) {
	console.error( `publish-plugin: ${ message }` );
	process.exit( 1 );
}
