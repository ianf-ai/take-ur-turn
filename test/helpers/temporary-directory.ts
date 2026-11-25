import { rm } from 'node:fs/promises';

/** Yield between bounded retries so Windows probe/CWD handles can close.
 * Always surface persistent cleanup failures, while retaining the original
 * assertion as the first error and cause if the test also failed. */
export async function withTemporaryDirectoryCleanup(directory: string, run: () => Promise<void>): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await run();
  } catch (error) {
    failure = { error };
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if (failure) {
      throw new AggregateError([failure.error, error], `Test failed and fixture cleanup failed: ${directory}`, { cause: failure.error });
    }
    throw error;
  }
  if (failure) throw failure.error;
}
