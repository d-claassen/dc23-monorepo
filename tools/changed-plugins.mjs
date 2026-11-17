#!/usr/bin/env node
/**
 * Lists the plugins affected by a change, as a JSON array of slugs.
 *
 * Usage:
 *   node tools/changed-plugins.mjs <base-ref> [<head-ref>]   plugins affected by base...head
 *   node tools/changed-plugins.mjs --all                      every plugin
 *
 * Rules:
 *   1. A change in plugins/<slug>/ affects <slug>.
 *   2. A plugin is also affected when a plugin it depends on is affected. Dependencies are
 *      read from the plugins' composer.json files (require, require-dev, suggest), so there
 *      is no hand-maintained list.
 *   3. A change anywhere outside plugins/ (root config, tools, workflows) affects every plugin.
 *   4. An unknown or missing base (first push, force push) affects every plugin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGINS_DIR = 'plugins';

function listPlugins() {
	return readdirSync( PLUGINS_DIR, { withFileTypes: true } )
		.filter( ( entry ) => entry.isDirectory() && existsSync( join( PLUGINS_DIR, entry.name, 'composer.json' ) ) )
		.map( ( entry ) => entry.name )
		.sort();
}

function readComposer( slug ) {
	return JSON.parse( readFileSync( join( PLUGINS_DIR, slug, 'composer.json' ), 'utf8' ) );
}

/** Map of slug => slugs of the monorepo plugins it depends on. */
function dependencyGraph( plugins ) {
	const slugByPackage = new Map( plugins.map( ( slug ) => [ readComposer( slug ).name, slug ] ) );
	const graph = new Map();
	for ( const slug of plugins ) {
		const composer = readComposer( slug );
		const names = Object.keys( { ...composer.require, ...composer[ 'require-dev' ], ...composer.suggest } );
		graph.set( slug, names.filter( ( name ) => slugByPackage.has( name ) ).map( ( name ) => slugByPackage.get( name ) ) );
	}
	return graph;
}

function changedFiles( base, head ) {
	try {
		return execFileSync( 'git', [ 'diff', '--name-only', `${ base }...${ head }` ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } )
			.split( '\n' )
			.filter( Boolean );
	} catch {
		return null;
	}
}

function affected( plugins, files ) {
	if ( files === null || files.some( ( file ) => ! file.startsWith( `${ PLUGINS_DIR }/` ) ) ) {
		return plugins;
	}
	const result = new Set(
		files.map( ( file ) => file.split( '/' )[ 1 ] ).filter( ( slug ) => plugins.includes( slug ) )
	);
	const graph = dependencyGraph( plugins );
	let grew = true;
	while ( grew ) {
		grew = false;
		for ( const [ slug, dependencies ] of graph ) {
			if ( ! result.has( slug ) && dependencies.some( ( dependency ) => result.has( dependency ) ) ) {
				result.add( slug );
				grew = true;
			}
		}
	}
	return plugins.filter( ( slug ) => result.has( slug ) );
}

const [ base, head = 'HEAD' ] = process.argv.slice( 2 );
const plugins = listPlugins();
const isNullSha = ( ref ) => ! ref || /^0+$/.test( ref );
const files = base === '--all' || isNullSha( base ) ? null : changedFiles( base, head );

process.stdout.write( JSON.stringify( affected( plugins, files ) ) + '\n' );
