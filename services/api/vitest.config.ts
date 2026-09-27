import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The worker service consumes the production queue as soon as anything
    // lands on it, so the suite publishes to a queue of its own.
    env: { TASK_QUEUE: 'inspector.tasks.test' },
    // The dashboard summary tests (tests/dashboard.test.ts) read a global
    // count, create their own data, and compare before vs. after, because
    // the database is shared and its absolute numbers aren't known. That
    // comparison only holds if no other file is mutating the same tables
    // concurrently, so test files run one at a time rather than in parallel.
    fileParallelism: false,
  },
});
