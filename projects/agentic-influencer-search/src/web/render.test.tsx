/**
 * A render smoke test: every component gets mounted once with representative
 * data. Cheap insurance that the transcript, result cards and shortlist actually
 * render the data-part shapes the server sends.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AudienceReport, Creator } from '../shared/creators';
import { creatorKey } from '../shared/feedback';
import type { ChatMessage, ShortlistEntry, UsageDataPart } from '../shared/messages';
import { Composer } from './components/Composer';
import { CreatorCard } from './components/CreatorCard';
import { CreditMeter } from './components/CreditMeter';
import { EmptyState } from './components/EmptyState';
import { MessageTranscript } from './components/MessageTranscript';
import { NextSteps } from './components/NextSteps';
import { Notices } from './components/Notices';
import { ReportCard } from './components/ReportCard';
import { RichText } from './components/RichText';
import { ShortlistPanel } from './components/ShortlistPanel';
import { CreatorFeedbackProvider } from './feedback';

const creator: Creator = {
  platform: 'instagram',
  userId: 'mock-1',
  username: 'demo.aurora.sleeps',
  fullName: 'Aurora (demo)',
  profileUrl: 'https://www.instagram.com/demo.aurora.sleeps/',
  followers: 48_000,
  engagementRate: 0.041,
  postsPerMonth: 11,
  medianViews: 62_000,
  accountCategory: 'Health & wellness',
  matchedPosts: [{ likes: 2_500, comments: 130, views: 62_000 }],
};

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Find sleep creators.' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'data-search',
        id: 'search-1',
        data: {
          kind: 'text-search',
          status: 'complete',
          platform: 'instagram',
          query: 'evening wind-down routines',
          filterSummary: ['followers 20K–200K', 'ER ≥ 3.0%'],
          rationale: 'Testing sleep-adjacent wellness content.',
          total: 12,
          creators: [creator],
          creditsSpent: 0.125,
        },
      },
      { type: 'text', text: 'Two strong fits: **@demo.aurora.sleeps** and one maybe.\n\n- high engagement\n- posts weekly' },
    ],
  },
];

const shortlist: ShortlistEntry[] = [
  { creator, reason: 'Consistent evening-routine content with 4.1% engagement.', fit: 'strong' },
];

const usage: UsageDataPart = {
  creditsSpent: 0.125,
  creditsBudget: 5,
  paidCalls: 1,
  mock: true,
};

test('the transcript renders search results and prose', () => {
  const html = renderToStaticMarkup(
    <MessageTranscript messages={messages} busy={false} onRunNextStep={() => {}} />,
  );
  assert.match(html, /demo\.aurora\.sleeps/);
  assert.match(html, /48K/);
  assert.match(html, /4\.1%/);
  assert.match(html, /evening wind-down routines/);
  assert.match(html, /<strong>@demo\.aurora\.sleeps<\/strong>/);
});

test('markdown the model actually writes is rendered, not shown raw', () => {
  // Both of these were displayed literally at one point: `##` as text, and a
  // bullet run that follows a lead-in line inside the same block.
  const html = renderToStaticMarkup(
    <RichText
      text={[
        '## Audience Reports',
        '',
        '@one is the clear winner:',
        '- **91.9% US audience** — perfect for the launch',
        '- 86.9% credibility',
        '',
        '### Recommendation',
        '',
        '1. Contact @one',
        '2. Drop @two',
      ].join('\n')}
    />,
  );

  assert.doesNotMatch(html, /##/, 'heading markers should not survive to the DOM');
  assert.match(html, /<h3[^>]*>Audience Reports<\/h3>/);
  assert.match(html, /<h3[^>]*>Recommendation<\/h3>/);
  assert.match(html, /<p[^>]*>.*is the clear winner.*<\/p>/);
  assert.match(html, /<ul[^>]*>.*91\.9% US audience.*<\/ul>/s);
  assert.match(html, /<ol[^>]*>.*Contact.*<\/ol>/s);
  assert.doesNotMatch(html, />- /, 'bullet markers should be consumed by the list');
});

test('creator cards show verdict buttons only inside a feedback provider', () => {
  // Outside a provider the card must still render — the buttons just aren't offered.
  const bare = renderToStaticMarkup(<CreatorCard creator={creator} />);
  assert.match(bare, /demo\.aurora\.sleeps/);
  assert.doesNotMatch(bare, /aria-pressed/);

  const withFeedback = renderToStaticMarkup(
    <CreatorFeedbackProvider
      verdicts={{ [creatorKey('instagram', 'demo.aurora.sleeps')]: 'like' }}
      onChange={() => {}}
    >
      <CreatorCard creator={creator} />
    </CreatorFeedbackProvider>,
  );
  assert.match(withFeedback, /aria-pressed="true"/, 'the liked state should be reflected');
  assert.match(withFeedback, /Undo liking @demo\.aurora\.sleeps/);
  assert.match(withFeedback, /Fewer creators like @demo\.aurora\.sleeps/);

  const disliked = renderToStaticMarkup(
    <CreatorFeedbackProvider
      verdicts={{ [creatorKey('instagram', 'demo.aurora.sleeps')]: 'dislike' }}
      onChange={() => {}}
    >
      <CreatorCard creator={creator} />
    </CreatorFeedbackProvider>,
  );
  assert.match(disliked, /opacity-50/, 'a rejected creator should be visibly dimmed');
});

test('next-step buttons render with their cost, and lock while the agent is busy', () => {
  const steps = [
    { label: 'Pull audience reports for the top 3', instruction: 'Pull audience reports for @a, @b and @c.', estimatedCredits: 3 },
    { label: 'Search TikTok with the same brief', instruction: 'Run the same brief on TikTok.' },
  ];

  const idle = renderToStaticMarkup(<NextSteps steps={steps} onRun={() => {}} disabled={false} />);
  assert.match(idle, /Pull audience reports for the top 3/);
  assert.match(idle, /~3 cr/);
  assert.match(idle, /free/);
  assert.doesNotMatch(idle, /disabled=""/);

  const busy = renderToStaticMarkup(<NextSteps steps={steps} onRun={() => {}} disabled />);
  assert.match(busy, /disabled=""/);

  assert.equal(renderToStaticMarkup(<NextSteps steps={[]} onRun={() => {}} disabled={false} />), '');
});

test('audience reports render their breakdowns and contact', () => {
  const report: AudienceReport = {
    platform: 'instagram',
    username: 'demo.aurora.sleeps',
    credibility: 0.82,
    followers: 48_000,
    engagementRate: 0.041,
    topCountries: [
      { label: 'United States (mock)', weight: 0.44 },
      { label: 'United Kingdom (mock)', weight: 0.14 },
    ],
    genders: [{ label: 'FEMALE', weight: 0.62 }],
    ageBrackets: [{ label: '25-34', weight: 0.38 }],
    contacts: [{ type: 'email', value: 'hello@demo.example' }],
  };

  const html = renderToStaticMarkup(
    <ReportCard part={{ status: 'complete', usernames: [report.username], reports: [report], creditsSpent: 1 }} />,
  );
  assert.match(html, /82% real/);
  assert.match(html, /United States \(mock\)/);
  assert.match(html, /25-34/);
  assert.match(html, /mailto:hello@demo\.example/);
  assert.match(html, /1 creator/);

  const failed = renderToStaticMarkup(
    <ReportCard part={{ status: 'error', usernames: ['demo.aurora.sleeps'], error: 'Out of credits.' }} />,
  );
  assert.match(failed, /Out of credits/);
});

test('the shortlist, meter, composer, empty state and notices render', () => {
  assert.match(renderToStaticMarkup(<ShortlistPanel entries={shortlist} onClose={() => {}} />), /strong/);
  assert.match(renderToStaticMarkup(<ShortlistPanel entries={[]} onClose={() => {}} />), /empty/);
  assert.match(renderToStaticMarkup(<CreditMeter usage={usage} />), /mock data/);
  assert.match(renderToStaticMarkup(<CreditMeter usage={null} />), /idle/);
  assert.match(
    renderToStaticMarkup(<Composer busy={false} onSend={() => {}} onStop={() => {}} />),
    /Search/,
  );
  const empty = renderToStaticMarkup(<EmptyState onPick={() => {}} disabled={false} />);
  assert.match(empty, /Sleep supplement launch/);
  assert.match(empty, /Vet the audience/);
  // No example may name a creator: a mock handle does not exist against the live API.
  assert.doesNotMatch(empty, /demo\.[a-z]/);
  assert.match(
    renderToStaticMarkup(
      <Notices notices={[{ id: 1, level: 'warning', message: 'Budget nearly spent.' }]} onDismiss={() => {}} />,
    ),
    /Budget nearly spent/,
  );
});
