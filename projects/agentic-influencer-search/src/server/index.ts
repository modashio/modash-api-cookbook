import { createApp } from './app';
import { config, describeConfig } from './env';
import { createLiveApi, type ModashApi } from './modash/api';
import { ModashClient } from './modash/client';
import { createMockApi } from './modash/mock';

const api: ModashApi = config.mock
  ? createMockApi()
  : createLiveApi(
      new ModashClient({
        token: config.modashToken,
        onRequest: ({ method, path, status, durationMs }) => {
          console.log(`[modash] ${method} ${path} → ${status} in ${durationMs}ms`);
        },
      }),
    );

createApp(api, { serveStaticWeb: config.isProduction }).listen(config.port, () => {
  console.log(`\n  Agentic influencer search — API on http://localhost:${config.port}`);
  console.log(`  ${describeConfig()}`);
  if (config.mock) {
    console.log('  Set MODASH_API_TOKEN in .env to run against real Modash data.');
  }
  if (!config.isProduction) {
    console.log('  UI on http://localhost:5173\n');
  }
});
