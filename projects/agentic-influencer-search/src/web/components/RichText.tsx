import { Fragment, type ReactNode } from 'react';

/**
 * Minimal markdown: headings, bullets, numbered lists, bold, inline code, @handles.
 * Deliberately not a markdown library — the point of this project is the API
 * integration, and a dependency-free renderer keeps the diff readable.
 *
 * It does have to cover what the model actually writes, though. Models mix a
 * lead-in line with bullets inside one block ("X is the winner:" followed by
 * `- ...`), so lines are classified individually rather than per block.
 */
export function RichText({ text, bubble = false }: { text: string; bubble?: boolean }) {
  if (!text.trim()) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {text
        .trim()
        .split(/\n{2,}/)
        .map((block, index) => (
          <Block key={index} lines={block.split('\n')} bubble={bubble} />
        ))}
    </div>
  );
}

type Group =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbers'; items: string[] }
  | { kind: 'paragraph'; lines: string[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function group(lines: string[]): Group[] {
  const groups: Group[] = [];

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      groups.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const last = groups.at(-1);
      if (last?.kind === 'bullets') last.items.push(bullet[1]!);
      else groups.push({ kind: 'bullets', items: [bullet[1]!] });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      const last = groups.at(-1);
      if (last?.kind === 'numbers') last.items.push(numbered[1]!);
      else groups.push({ kind: 'numbers', items: [numbered[1]!] });
      continue;
    }

    const last = groups.at(-1);
    if (last?.kind === 'paragraph') last.lines.push(line);
    else groups.push({ kind: 'paragraph', lines: [line] });
  }

  return groups;
}

function Block({ lines, bubble }: { lines: string[]; bubble: boolean }) {
  const listClass = 'm-0 flex list-outside flex-col gap-1 pl-[18px]';

  return (
    <>
      {group(lines).map((entry, index) => {
        if (entry.kind === 'heading') {
          return (
            <h3
              key={index}
              className={
                entry.level <= 2
                  ? 'm-0 mt-1 text-[14px] font-semibold text-text'
                  : 'm-0 mt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim'
              }
            >
              {inline(entry.text)}
            </h3>
          );
        }

        if (entry.kind === 'bullets') {
          return (
            <ul key={index} className={`${listClass} list-disc`}>
              {entry.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        if (entry.kind === 'numbers') {
          return (
            <ol key={index} className={`${listClass} list-decimal`}>
              {entry.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ol>
          );
        }

        return (
          <p
            key={index}
            className={
              bubble
                ? 'm-0 rounded-md border border-accent-border bg-accent-soft px-[13px] py-2.5'
                : 'm-0'
            }
          >
            {entry.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

const codeClass =
  'rounded-[5px] border border-border-soft bg-bg-input px-[0.35em] py-[0.1em] font-mono text-[0.9em]';

function inline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|@[\w.]+)/g);

  return tokens.map((token, index) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <code key={index} className={codeClass}>
          {token.slice(1, -1)}
        </code>
      );
    }
    if (/^@[\w.]+$/.test(token)) {
      return (
        <span key={index} className="font-mono text-[0.92em] text-accent">
          {token}
        </span>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}
