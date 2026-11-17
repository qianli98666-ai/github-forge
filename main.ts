// main.ts — entrypoint: start the forge server, register its port with the
// make.fun environment, and stay up until the environment says it is done.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  console.error('error: MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Register this process's port with the environment. 200 or 409 means the
// environment accepted the registration. 400/405 is a fatal rejection.
// Anything else (network error, timeout, other status) is retried with
// exponential backoff starting at 250ms and capped at 2000ms.
async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    let res: Response | undefined;
    try {
      res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      res = undefined;
    }
    if (res !== undefined) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with status ${res.status}`);
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

// Poll the environment until it reports done. Each request times out after
// 30s; timeouts, network errors and not-yet-done answers are all retried
// with the same backoff. This never returns before done === true.
async function waitUntilDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Timeout, network error, or a non-JSON body: retry below.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`listening on port ${port}`);

  await register(port);
  await waitUntilDone();

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
