import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		silent: true,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// index.ts is a thin router; types.ts holds type declarations only.
			exclude: ["src/index.ts", "src/types.ts"],
			reporter: ["text", "json-summary", "lcov"],
			thresholds: {
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90,
			},
		},
	},
});
