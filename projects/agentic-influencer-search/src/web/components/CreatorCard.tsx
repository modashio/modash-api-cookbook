import type { Creator } from '../../shared/creators';
import { creatorKey } from '../../shared/feedback';
import { formatCount, formatPercent } from '../../shared/format';
import { useCreatorFeedback } from '../feedback';
import { VerdictButtons } from './VerdictButtons';

const STAT_LABEL = 'text-[10px] tracking-[0.04em] whitespace-nowrap text-text-faint uppercase';
const STAT_VALUE = 'mt-px mb-0 font-mono text-xs tabular-nums';
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

export function CreatorCard({ creator, compact = false }: { creator: Creator; compact?: boolean }) {
  const { verdicts, setVerdict, enabled } = useCreatorFeedback();
  const verdict = verdicts[creatorKey(creator.platform, creator.username)];

  return (
    <article
      className={`${
        compact
          ? 'flex flex-col gap-1.5 p-2'
          : 'flex flex-col gap-2 rounded-sm border border-border-soft bg-bg-card p-3'
      } ${verdict === 'dislike' ? 'opacity-50' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-1">
        <a
          className="group flex min-w-0 flex-1 items-center gap-2 text-inherit hover:no-underline"
          href={creator.profileUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {creator.profilePicture ? (
            <img
              className="size-[34px] shrink-0 rounded-full bg-border object-cover"
              src={creator.profilePicture}
              alt=""
              loading="lazy"
            />
          ) : (
            <span className="size-[34px] shrink-0 rounded-full bg-border" aria-hidden="true" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className={`text-[12.5px] font-semibold ${ELLIPSIS} group-hover:text-accent`}>
              @{creator.username}
            </span>
            {creator.fullName && (
              <span className={`text-[11px] text-text-faint ${ELLIPSIS}`}>{creator.fullName}</span>
            )}
          </span>
        </a>

        {enabled && (
          <VerdictButtons
            verdict={verdict}
            username={creator.username}
            onSet={(next) => setVerdict(creator.platform, creator.username, next)}
          />
        )}
      </div>

      {/* Two columns, always. Four made the labels collide at card width. */}
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div>
          <dt className={STAT_LABEL}>Followers</dt>
          <dd className={STAT_VALUE}>{formatCount(creator.followers)}</dd>
        </div>
        <div>
          <dt className={STAT_LABEL}>Engagement</dt>
          <dd className={STAT_VALUE}>{formatPercent(creator.engagementRate)}</dd>
        </div>
        <div>
          <dt className={STAT_LABEL}>Med. views</dt>
          <dd className={STAT_VALUE}>{formatCount(creator.medianViews)}</dd>
        </div>
        <div>
          <dt className={STAT_LABEL}>Posts/mo</dt>
          <dd className={STAT_VALUE}>{creator.postsPerMonth ? Math.round(creator.postsPerMonth) : '—'}</dd>
        </div>
      </dl>

      {creator.accountCategory && (
        <p className={`m-0 text-[11px] text-text-faint ${ELLIPSIS}`}>{creator.accountCategory}</p>
      )}

      {!compact && creator.matchedPosts.length > 0 && (
        <div className="flex gap-1">
          {creator.matchedPosts.map((post, index) => {
            const thumb = post.thumbnail ? (
              <img className="block aspect-square w-full rounded-md bg-border-soft object-cover" src={post.thumbnail} alt="" loading="lazy" />
            ) : (
              <span className="block aspect-square w-full rounded-md bg-border-soft" />
            );

            return post.url ? (
              <a
                key={index}
                className="min-w-0 flex-1"
                href={post.url}
                target="_blank"
                rel="noreferrer noopener"
                title={`${formatCount(post.views)} views · ${formatCount(post.likes)} likes`}
              >
                {thumb}
              </a>
            ) : (
              <span
                key={index}
                className="min-w-0 flex-1"
                title={`${formatCount(post.views)} views · ${formatCount(post.likes)} likes`}
              >
                {thumb}
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}
