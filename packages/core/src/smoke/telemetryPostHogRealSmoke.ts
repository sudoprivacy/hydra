/**
 * Real PostHog smoke (manual / opt-in).
 *
 * Does an actual capture against PostHog cloud and waits for flush() to
 * drain the queue. Skipped unless HYDRA_POSTHOG_REAL_TEST=1 so CI never
 * makes outbound network calls to PostHog.
 *
 * The engineer running this must verify the event landed via the PostHog
 * dashboard (search for the printed `distinct_id` / `marker`). This is
 * intentionally not an automated assertion — closing the loop would
 * require a personal PostHog API key with read access, which we do not
 * embed in this repo.
 *
 * Usage:
 *   HYDRA_POSTHOG_REAL_TEST=1 \
 *   HYDRA_POSTHOG_API_KEY=phc_your_test_key \
 *   node out/smoke/telemetryPostHogRealSmoke.js
 *
 * Optional:
 *   HYDRA_POSTHOG_HOST=https://eu.i.posthog.com   # override host
 */

import * as crypto from 'node:crypto';

async function main(): Promise<void> {
  if (process.env.HYDRA_POSTHOG_REAL_TEST !== '1') {
    console.log('telemetryPostHogRealSmoke: SKIP (set HYDRA_POSTHOG_REAL_TEST=1 to run)');
    return;
  }

  const apiKey = process.env.HYDRA_POSTHOG_API_KEY;
  if (!apiKey) {
    console.log('telemetryPostHogRealSmoke: SKIP (set HYDRA_POSTHOG_API_KEY to a test key)');
    return;
  }

  const telemetry = await import('../core/telemetry');
  telemetry.resetTelemetryForTesting();

  const marker = `hydra-real-smoke-${crypto.randomUUID()}`;
  const distinctId = crypto.randomUUID();
  const backend = new telemetry.PostHogBackend();
  const client = new telemetry.TelemetryClient({
    backend,
    anonymousId: distinctId,
    hydraVersion: '0.0.0-real-smoke',
    timeoutMs: 5000,
  });

  const start = process.hrtime.bigint();
  client.capture('hydra_real_smoke', { marker });
  await client.flush();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  console.log(
    'telemetryPostHogRealSmoke: ok ' +
    `(elapsed=${elapsedMs.toFixed(0)}ms distinct_id=${distinctId} marker=${marker})`,
  );
  console.log(
    'telemetryPostHogRealSmoke: verify in PostHog → Activity → search by distinct_id or marker.',
  );
}

main().catch((err: unknown) => {
  console.error(
    'telemetryPostHogRealSmoke: FAIL —',
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exitCode = 1;
});
