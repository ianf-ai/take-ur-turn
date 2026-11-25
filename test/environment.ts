import { it } from 'vitest';

/** Wall-clock measurements and long synthetic-clock soaks are explicit
 * exclusions from gates. Existing platform skipIf annotations stay local.
 * Full/component runs retain every assertion and original timeout. */
export const measurement: ReturnType<typeof it.skipIf> = it.skipIf(['dev-mac', 'win32-gate'].includes(process.env.TUT_TEST_PROFILE ?? ''));

// Host budget for real Win32 fixture hops, including multiple stop/launch rounds.
// Inner condition waits and product protocol deadlines keep their own budgets.
export const nativeFixtureTimeoutMs = 6 * 60_000;
