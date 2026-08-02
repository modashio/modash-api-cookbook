import 'dotenv/config';
import * as z from 'zod';

/**
 * Everything the server needs from the environment, validated once at startup so a typo in
 * `.env` fails immediately instead of halfway through a tool call.
 */
const environmentSchema = z.object({
  MODASH_API_TOKEN: z.string().min(1).optional(),
  MODASH_API_BASE_URL: z.url().default('https://api.modash.io/v1'),
  // `.optional()` wraps the transform rather than the other way round, so an unset variable stays
  // undefined instead of being transformed into `false`.
  MODASH_MOCK: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  MODASH_CREDIT_BUDGET: z.coerce.number().positive().default(5),
  // The RAW API is a separate product, so its tools are opt-in and its allowance is separate.
  MODASH_RAW: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  MODASH_RAW_BUDGET: z.coerce.number().int().positive().default(50),
  PORT: z.coerce.number().int().positive().default(3000),
  // Namespaced rather than plain `HOST`, so an unrelated variable already in the environment
  // cannot widen the binding by accident.
  MODASH_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
});

export interface Config {
  /** When true, no HTTP request ever leaves the process and no credits are spent. */
  mock: boolean;
  apiToken: string | undefined;
  baseUrl: string;
  /** Hard ceiling on estimated credit spend for the lifetime of this process. */
  creditBudget: number;
  /** Whether to expose the RAW API tools. Off unless asked for; RAW is sold separately. */
  raw: boolean;
  /** Hard ceiling on RAW requests for the lifetime of this process. Counted in requests. */
  rawBudget: number;
  port: number;
  /** Loopback unless deliberately widened. The transport has no auth of its own. */
  httpHost: string;
}

/**
 * Drops variables that are set but carry nothing usable.
 *
 * Both plugin packagings hand this process its configuration through the environment, and both
 * have a way of producing a variable that is present but meaningless:
 *
 *  - Claude Code expands `${MODASH_API_TOKEN:-}` in `.mcp.json` to an empty string when the user
 *    has not exported a token. Without the `:-` fallback it does something worse and passes the
 *    literal text `${MODASH_API_TOKEN}` through unexpanded.
 *  - Claude Desktop passes an empty string for an optional `user_config` field left blank.
 *
 * In every one of those cases the honest reading is "no token", which puts the server in mock
 * mode. Treating an empty string as a token would send `Authorization: Bearer ` and get a 401.
 */
const meaningfulValuesOnly = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) =>
        value !== undefined && value.trim() !== '' && !/^\$\{[^}]*\}$/.test(value.trim()),
    ),
  );

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse(meaningfulValuesOnly(env));
  if (!parsed.success) {
    const problems = z.prettifyError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const {
    MODASH_API_TOKEN,
    MODASH_API_BASE_URL,
    MODASH_MOCK,
    MODASH_CREDIT_BUDGET,
    MODASH_RAW,
    MODASH_RAW_BUDGET,
    PORT,
    MODASH_HTTP_HOST,
  } = parsed.data;

  // Mock mode is the default whenever there is no token, so `npm install && npm run dev` works
  // for a reader who has not talked to Modash yet. An explicit MODASH_MOCK still wins.
  const mock = MODASH_MOCK ?? MODASH_API_TOKEN === undefined;

  if (!mock && MODASH_API_TOKEN === undefined) {
    throw new Error(
      'MODASH_MOCK=false but MODASH_API_TOKEN is not set. Get a token from ' +
        'https://marketer.modash.io/developer, or unset MODASH_MOCK to run against fixtures.',
    );
  }

  return {
    mock,
    apiToken: MODASH_API_TOKEN,
    baseUrl: MODASH_API_BASE_URL,
    creditBudget: MODASH_CREDIT_BUDGET,
    raw: MODASH_RAW ?? false,
    rawBudget: MODASH_RAW_BUDGET,
    port: PORT,
    httpHost: MODASH_HTTP_HOST,
  };
}
