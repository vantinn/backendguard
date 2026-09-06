import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    /**
     * Much of this suite drives the CLI as a real process — that is deliberate,
     * because the exit code and stdout are the contract that broke in 0.9.1 and
     * only a spawned process proves them. Spawning a Node process costs a few
     * hundred milliseconds, and a test that spawns a dozen of them exceeds
     * Vitest's 5s default whenever the machine is loaded, which showed up as an
     * intermittently failing documentation-contract test rather than as a real
     * defect. The budget below is the wall clock a spawning test may take; a
     * genuinely hung command still fails, just at a bound that is not noise.
     */
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
