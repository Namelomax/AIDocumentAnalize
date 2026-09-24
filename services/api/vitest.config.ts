import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The worker service consumes the production queue as soon as anything
    // lands on it, so the suite publishes to a queue of its own.
    env: { TASK_QUEUE: 'inspector.tasks.test' },
  },
});
