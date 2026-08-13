import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		reporter: ['default', 'junit'],
		outputFile: {
			junit: './reports/junit.xml'
		},
		coverage: {
			reporter: ['lcov', 'text'],
			thresholds: {
				statements: 80,
				branches: 75,
				functions: 80,
				lines: 80
			}
		}
	}
});
