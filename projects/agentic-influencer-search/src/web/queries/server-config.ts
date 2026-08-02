/**
 * Note the directory name: client modules must not live under `src/web/api/`.
 * Vite serves source modules from the dev-server root, so that path would be
 * requested as `/api/config.ts` and swallowed by the `/api` proxy rule before
 * Vite ever saw it.
 */

import { useQuery } from '@tanstack/react-query';

export interface ServerConfig {
  mock: boolean;
  creditBudget: number;
}

async function fetchServerConfig(): Promise<ServerConfig> {
  const response = await fetch('/api/config');
  if (!response.ok) {
    throw new Error(`Failed to load /api/config (${response.status})`);
  }
  return response.json() as Promise<ServerConfig>;
}

/** Static for the process lifetime — no need to refetch on focus or go stale quickly. */
export const serverConfigQueryOptions = {
  queryKey: ['server-config'] as const,
  queryFn: fetchServerConfig,
  staleTime: Infinity,
  refetchOnWindowFocus: false,
};

export function useServerConfig() {
  return useQuery(serverConfigQueryOptions);
}
