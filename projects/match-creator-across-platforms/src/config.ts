import * as z from 'zod';

const environmentSchema = z.object({
  MODASH_API_TOKEN: z.string().min(1).optional(),
  MODASH_MOCK: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  MODASH_CREDIT_BUDGET: z.coerce.number().positive().default(50),
});

export interface Config {
  mock: boolean;
  /** True when mock mode is on only because no token is set. */
  mockByDefault: boolean;
  apiToken: string | undefined;
  creditBudget: number;
}

// An empty string, or a `${VAR}` an editor passed through unexpanded, means "not set".
const meaningfulValuesOnly = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => value !== undefined && value.trim() !== '' && !/^\$\{[^}]*\}$/.test(value.trim()),
    ),
  );

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse(meaningfulValuesOnly(env));
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const { MODASH_API_TOKEN, MODASH_MOCK, MODASH_CREDIT_BUDGET } = parsed.data;
  if (MODASH_MOCK === false && !MODASH_API_TOKEN) {
    throw new Error('MODASH_MOCK is false but MODASH_API_TOKEN is not set.');
  }
  return {
    mock: MODASH_MOCK ?? !MODASH_API_TOKEN,
    mockByDefault: MODASH_MOCK === undefined && !MODASH_API_TOKEN,
    apiToken: MODASH_API_TOKEN,
    creditBudget: MODASH_CREDIT_BUDGET,
  };
}
