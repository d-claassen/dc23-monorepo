#!/usr/bin/env node
/**
 * Lists, as JSON, the plugins a change can affect: the ones it touches, the ones that depend on
 * those, or all of them when shared files change.
 *
 * Usage: node tools/changed-plugins.mjs <base-ref> [<head-ref>] | --all
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
