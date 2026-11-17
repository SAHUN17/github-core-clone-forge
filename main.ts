// The entry <-> env lifecycle, exactly as the harness drives it. app.ts is the forge; this file
// starts it, tells the env where it listens, and keeps the process alive until the env says the
// trial is over.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial). Without it there
//      is nothing to register with, so the program exits 1 at once.
//   2. The server binds an ephemeral port: listen(0), never 8080, which the env owns.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came
//      from plus N as the forge's base URL and dials it from then on. The first register wins; a
//      409 means another process already registered and this one keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once, so
//      this is a poll with a short backoff, never a long-held request.
//   5. Close the server and exit 0. The env then writes the export the scorer reads.

import { createApp } from './app.ts';

/** The env's origin; a trailing slash would double up in every path built from it. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One register or done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The first wait between failed requests, and the longest one. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_FIRST_MS, capped. */
function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port to the env until it accepts it. 200 is the normal answer and 409 means a
 * first register already won, which is not this process's to fix; both end the loop. 400 and 405
 * are contract errors and end the program; anything else is retried, since the env may still be
 * coming up.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await wait(backoff(attempt));
  }
}

/** Poll the env until the trial is over; it answers at once, so every failure is a retry. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 200) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll says nothing about the trial: retry it.
    }
    await wait(backoff(attempt));
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server bound no port'));
        return;
      }
      resolve(address.port);
    });
  });
  await register(port);
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

void main();