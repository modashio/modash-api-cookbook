/**
 * Configuration, read once at startup.
 *
 * Node loads `.env` natively (`process.loadEnvFile`), so there's no dotenv
 * dependency. Mock mode is the default when there's no Modash token, which is
 * what makes `git clone && npm run dev` work for someone who is still deciding
 * whether to buy API access.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve(process.cwd(), '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' || value === '1' || value === 'yes';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const token = process.env.MODASH_API_TOKEN?.trim() ?? '';
const mockOverride = bool(process.env.MODASH_MOCK);

export const config = {
  port: num(process.env.PORT, 3000),
  modashToken: token,
  /** Explicit MODASH_MOCK wins; otherwise mock whenever there's no token. */
  mock: mockOverride ?? token === '',
  creditBudget: num(process.env.MODASH_CREDIT_BUDGET, 5),
  maxPageSize: Math.min(num(process.env.MODASH_MAX_PAGE_SIZE, 20), 50),
  isProduction: process.env.NODE_ENV === 'production',
} as const;

export function describeConfig(): string {
  return [
    config.mock ? 'data: MOCK (synthetic, no credits spent)' : 'data: LIVE Modash API',
    `credit budget per session: ${config.creditBudget}`,
    `max profiles per search: ${config.maxPageSize}`,
  ].join(' | ');
}
