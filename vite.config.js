import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		reporter: ['default', 'junit'],
		outputFile: {
			junit: './reports/junit.xml'
		}
	}
});
