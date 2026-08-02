/**
 * The storage layer's job is to never lose the app to a corrupt or oversized
 * payload, so that is what these cover: round-tripping, version mismatch,
 * garbage, and the quota path that evicts rather than throws.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { ChatMessage } from '../../shared/messages';

/** Minimal localStorage, with an optional byte budget to force eviction. */
class MemoryStorage {
  private data = new Map<string, string>();
  constructor(private readonly maxBytes = Infinity) {}

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (value.length > this.maxBytes) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.data.set(key, value);
  }

  removeItem(key: string) {
    this.data.delete(key);
  }
}

function installStorage(maxBytes?: number): MemoryStorage {
  const store = new MemoryStorage(maxBytes);
  (globalThis as { localStorage?: unknown }).localStorage = store;
  return store;
}

// The module reads `localStorage` lazily, so it can be imported before one exists.
const { createChat, loadChats, saveChats, shortlistSize, titleFor } = await import('./chat-store');

function chatWith(messages: ChatMessage[], overrides: Partial<{ updatedAt: number }> = {}) {
  return { ...createChat(), messages, ...overrides };
}

function userMessage(text: string): ChatMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  installStorage();
});

test('chats round-trip and come back newest first', () => {
  const older = chatWith([userMessage('older')], { updatedAt: 1_000 });
  const newer = chatWith([userMessage('newer')], { updatedAt: 2_000 });

  saveChats([older, newer]);
  const loaded = loadChats();

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.id, newer.id);
  assert.equal(loaded[1]?.messages[0]?.parts[0]?.type, 'text');
});

test('a payload from an older version is discarded rather than crashing', () => {
  const store = installStorage();
  store.setItem('modash-cookbook.chats', JSON.stringify({ version: 0, chats: [chatWith([])] }));

  assert.deepEqual(loadChats(), []);
  assert.equal(store.getItem('modash-cookbook.chats'), null, 'the stale payload should be cleared');
});

test('corrupt JSON is discarded rather than crashing', () => {
  const store = installStorage();
  store.setItem('modash-cookbook.chats', '{ not json');

  assert.deepEqual(loadChats(), []);
  assert.equal(store.getItem('modash-cookbook.chats'), null);
});

test('hitting the quota evicts the oldest chats instead of throwing', () => {
  // Roughly two chats' worth of the payload below.
  installStorage(2_600);

  const chats = Array.from({ length: 6 }, (_, index) =>
    chatWith([userMessage('x'.repeat(300))], { updatedAt: 1_000 + index }),
  );

  const written = saveChats(chats);

  assert.ok(written.length > 0, 'should keep what fits');
  assert.ok(written.length < chats.length, 'should have dropped something');
  // Newest survive: they are sorted before the eviction loop trims from the end.
  assert.equal(written[0]?.id, chats.at(-1)?.id);
  assert.deepEqual(
    loadChats().map((chat) => chat.id),
    written.map((chat) => chat.id),
  );
});

test('storage being unavailable is not fatal', () => {
  delete (globalThis as { localStorage?: unknown }).localStorage;

  assert.deepEqual(loadChats(), []);
  const chats = [chatWith([])];
  assert.deepEqual(saveChats(chats), chats, 'callers keep their in-memory state');
});

test('titles come from the first user message', () => {
  assert.equal(titleFor([userMessage('Find sleep creators')], 'New search'), 'Find sleep creators');
  assert.equal(titleFor([], 'New search'), 'New search');
  assert.equal(titleFor([userMessage('a'.repeat(200))], 'New search').length, 58);
  assert.equal(titleFor([userMessage('multi\n  line   brief')], 'New search'), 'multi line brief');
});

test('the shortlist count comes from the latest shortlist part', () => {
  const creator = {
    platform: 'instagram' as const,
    username: 'demo.one',
    profileUrl: 'https://example',
    matchedPosts: [],
  };

  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'assistant',
      parts: [
        { type: 'data-shortlist', data: { entries: [{ creator, reason: 'a', fit: 'strong' }] } },
        {
          type: 'data-shortlist',
          data: {
            entries: [
              { creator, reason: 'a', fit: 'strong' },
              { creator: { ...creator, username: 'demo.two' }, reason: 'b', fit: 'possible' },
            ],
          },
        },
      ],
    },
  ];

  assert.equal(shortlistSize(messages), 2);
  assert.equal(shortlistSize([]), 0);
});
