/**
 * `npm run check-token`
 *
 * The first thing to run when you get API access. Calls only free endpoints
 * (`GET /user/info` and a dictionary lookup), so it costs nothing and tells you
 * whether auth, credits, and AI Search access are all in place.
 */

import { config } from '../server/env';
import { createLiveApi } from '../server/modash/api';
import { ModashApiError, ModashClient } from '../server/modash/client';

async function main(): Promise<void> {
  if (!config.modashToken) {
    console.error('No MODASH_API_TOKEN set. Copy .env.example to .env and add your token.');
    console.error('Get one at https://marketer.modash.io/developer');
    process.exitCode = 1;
    return;
  }

  const api = createLiveApi(new ModashClient({ token: config.modashToken }));

  const info = await api.accountInfo();
  console.log('Token accepted.');
  console.log(`  credits remaining:  ${info.credits ?? 'unknown'}`);
  console.log(`  discovery rate limit: ${info.discoveryRateLimit ?? 'unknown'} req/min`);

  const locations = await api.locations('instagram', 'berlin');
  console.log(`  dictionary lookup:  ${locations.length} location(s) for "berlin" (free)`);
  for (const location of locations.slice(0, 3)) {
    console.log(`      ${location.id}  ${location.title}`);
  }

  console.log('\nAll checks used free endpoints — 0 credits spent.');
  console.log('Run `npm run dev` to start the agent, or `npm run search "<brief>"` for the CLI.');
}

main().catch((error: unknown) => {
  if (error instanceof ModashApiError) {
    console.error(`\nModash API error (${error.code}): ${error.userFacingMessage}`);
  } else {
    console.error('\nUnexpected failure:', error);
  }
  process.exitCode = 1;
});
