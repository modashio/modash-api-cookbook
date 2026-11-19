import * as z from 'zod';

const environmentSchema = z.object({
  MODASH_API_TOKEN: z.string().min(1).optional(),
  MODASH_CREDIT_BUDGET: z.coerce.number().positive().default(50),
});

export interface Config {
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
  const { MODASH_API_TOKEN, MODASH_CREDIT_BUDGET } = parsed.data;
  return {
    apiToken: MODASH_API_TOKEN,
    creditBudget: MODASH_CREDIT_BUDGET,
  };
}
