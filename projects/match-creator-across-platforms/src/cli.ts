import 'dotenv/config';

import { run, UsageError } from './run.js';

try {
  process.exitCode = await run({ argv: process.argv.slice(2) });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
