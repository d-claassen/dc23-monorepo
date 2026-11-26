/**
 * WordPress dependencies
 */
const { test, expect } = require( '@wordpress/e2e-test-utils-playwright' );

test.describe( 'education Block', () => {
	test.beforeEach( async ( { admin } ) => {
		await admin.createNewPost();
	} );

	test( 'can be filled in from the editor', async ( { editor } ) => {
		await editor.insertBlock( { name: 'dc23-portfolio/education' } );

		const educationBlock = editor.canvas.locator(
			'[data-type="dc23-portfolio/education"]'
		);
		await expect( educationBlock ).toBeVisible();

		await educationBlock
			.getByLabel( 'Degree / Program' )
			.fill( 'Bachelor of Software Engineering' );
		await educationBlock
			.getByLabel( 'Institution' )
			.fill( 'University of City' );
		await educationBlock
			.getByLabel( 'Description' )
			.fill( 'Majored in software engineering and testing.' );

		const content = await editor.getEditedPostContent();
		expect( content ).toContain( 'Bachelor of Software Engineering' );
		expect( content ).toContain( 'University of City' );
		expect( content ).toContain(
			'Majored in software engineering and testing.'
		);
	} );

	test( 'shows the education on the published page', async ( {
		page,
		editor,
	} ) => {
		await editor.insertBlock( { name: 'dc23-portfolio/education' } );

		const educationBlock = editor.canvas.locator(
			'[data-type="dc23-portfolio/education"]'
		);
		await educationBlock
			.getByLabel( 'Degree / Program' )
			.fill( 'Bachelor of Software Engineering' );
		await educationBlock
			.getByLabel( 'Institution' )
			.fill( 'University of City' );
		await educationBlock
			.getByLabel( 'Description' )
			.fill( 'Majored in software engineering and testing.' );

		const postId = await editor.publishPost();
		await page.goto( `/?p=${ postId }` );

		const education = page.locator( '.wp-block-dc23-portfolio-education' );
		await expect( education.locator( '.education-degree' ) ).toHaveText(
			'Bachelor of Software Engineering'
		);
		await expect(
			education.locator( '.education-institution' )
		).toHaveText( 'University of City' );
		await expect(
			education.locator( '.education-description' )
		).toHaveText( 'Majored in software engineering and testing.' );
	} );
} );
