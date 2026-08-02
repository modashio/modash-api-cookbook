/**
 * `npm run search -- "we're launching a magnesium sleep supplement…"`
 *
 * The same agent, no browser. Useful for tuning the prompt and for seeing how
 * many credits a brief actually costs before you wire it into a product.
 */

import type { UIMessageChunk } from 'ai';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../server/agent/agent';
import { config, describeConfig } from '../server/env';
import { createLiveApi, type ModashApi } from '../server/modash/api';
import { ModashClient } from '../server/modash/client';
import { createMockApi } from '../server/modash/mock';
import { PLATFORM_LABELS } from '../shared/creators';
import { formatCount, formatCredits, formatPercent } from '../shared/format';
import type { ChatMessage } from '../shared/messages';

const brief = process.argv.slice(2).join(' ').trim();

if (!brief) {
  console.error('Usage: npm run search -- "<your campaign brief>"');
  process.exit(1);
}

let openTextBlock = false;

async function main(): Promise<void> {
  const api: ModashApi = config.mock
    ? createMockApi()
    : createLiveApi(new ModashClient({ token: config.modashToken }));

  console.log(`\n${describeConfig()}\n`);
  console.log(`brief: ${brief}\n${'─'.repeat(72)}`);

  const messages: ChatMessage[] = [
    { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: brief }] },
  ];

  const stream = runAgent({
    messages,
    api,
    creditBudget: config.creditBudget,
    maxPageSize: config.maxPageSize,
  });

  for await (const chunk of stream as ReadableStream<UIMessageChunk> & AsyncIterable<UIMessageChunk>) {
    switch (chunk.type) {
      case 'text-delta':
        process.stdout.write(chunk.delta);
        openTextBlock = true;
        break;

      case 'tool-input-start':
        endTextBlock();
        process.stdout.write(`\n· ${chunk.toolName} `);
        break;

      case 'tool-output-available':
        process.stdout.write('✓\n');
        break;

      case 'tool-output-error':
        process.stdout.write(`✗ ${chunk.errorText}\n`);
        break;

      case 'data-search':
        endTextBlock();
        printSearch(chunk.data as SearchPart);
        break;

      case 'data-usage': {
        const usage = chunk.data as { creditsSpent: number; creditsBudget: number };
        endTextBlock();
        console.log(`\n  credits: ${formatCredits(usage.creditsSpent)} / ${usage.creditsBudget}`);
        break;
      }

      case 'error':
        endTextBlock();
        console.error(`\nerror: ${chunk.errorText}`);
        break;

      default:
        break;
    }
  }

  endTextBlock();
  console.log(`\n${'─'.repeat(72)}\ndone`);
}

function endTextBlock(): void {
  if (openTextBlock) {
    process.stdout.write('\n');
    openTextBlock = false;
  }
}

main().catch((error: unknown) => {
  endTextBlock();
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

interface SearchPart {
  status: string;
  platform: keyof typeof PLATFORM_LABELS;
  query: string;
  filterSummary: string[];
  total?: number;
  creditsSpent?: number;
  creators?: Array<{
    username: string;
    followers?: number;
    engagementRate?: number;
    accountCategory?: string;
  }>;
  error?: string;
}

function printSearch(search: SearchPart): void {
  if (search.status === 'running') {
    console.log(`\n  ${PLATFORM_LABELS[search.platform]} search: "${search.query}"`);
    if (search.filterSummary.length) console.log(`  filters: ${search.filterSummary.join(', ')}`);
    return;
  }

  if (search.status === 'error') {
    console.log(`  → failed: ${search.error}`);
    return;
  }

  console.log(`  → ${search.creators?.length ?? 0} of ${search.total ?? '?'} matches`);
  for (const creator of search.creators ?? []) {
    const stats = `${formatCount(creator.followers).padStart(6)}  ${formatPercent(creator.engagementRate).padStart(6)}`;
    console.log(`     @${creator.username.padEnd(26)} ${stats}  ${creator.accountCategory ?? ''}`);
  }
}
