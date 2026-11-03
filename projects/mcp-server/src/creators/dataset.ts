import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import url from 'node:url';

export const COLUMNS = [
  'creator_id',
  'name',
  'n_platforms',
  'anchor_platform',
  'max_followers',
  'has_email',
  'creator_country',
  'creator_country_code',
  'creator_city',
  'creator_location_source',
  'creator_location_multi_country',
  'audience_platform',
  'audience_report_date',
  'audience_top_country',
  'audience_top_country_code',
  'audience_top_country_share',
  'audience_top3_countries',
  'audience_top_city',
  'ig_handle',
  'ig_url',
  'ig_followers',
  'tt_handle',
  'tt_url',
  'tt_followers',
  'yt_handle',
  'yt_url',
  'yt_followers',
  'ig_feed_posts_sep26',
  'ig_feed_views_sep26',
  'ig_feed_likes_sep26',
  'ig_feed_comments_sep26',
  'ig_reels_posts_sep26',
  'ig_reels_views_sep26',
  'ig_reels_likes_sep26',
  'ig_reels_comments_sep26',
  'ig_posts_sep26',
  'ig_views_sep26',
  'ig_likes_sep26',
  'ig_comments_sep26',
  'tt_posts_sep26',
  'tt_views_sep26',
  'tt_likes_sep26',
  'tt_comments_sep26',
  'yt_long_posts_sep26',
  'yt_long_views_sep26',
  'yt_long_likes_sep26',
  'yt_long_comments_sep26',
  'yt_shorts_posts_sep26',
  'yt_shorts_views_sep26',
  'yt_shorts_likes_sep26',
  'yt_shorts_comments_sep26',
  'yt_posts_sep26',
  'yt_views_sep26',
  'yt_likes_sep26',
  'yt_comments_sep26',
  'total_posts_sep26',
  'total_views_sep26',
  'total_likes_sep26',
  'total_comments_sep26',
  'sep26_last_collected_date',
  'extra_accounts_dropped',
] as const;

export type Column = (typeof COLUMNS)[number];

export type CellValue = string | number | boolean | null;
export type CreatorRow = Record<Column, CellValue>;

const BOOLEAN_COLUMNS: ReadonlySet<Column> = new Set(['has_email', 'creator_location_multi_country']);

const STRING_COLUMNS: ReadonlySet<Column> = new Set([
  'creator_id',
  'name',
  'anchor_platform',
  'creator_country',
  'creator_country_code',
  'creator_city',
  'creator_location_source',
  'audience_platform',
  'audience_report_date',
  'audience_top_country',
  'audience_top_country_code',
  'audience_top3_countries',
  'audience_top_city',
  'ig_handle',
  'ig_url',
  'tt_handle',
  'tt_url',
  'yt_handle',
  'yt_url',
  'sep26_last_collected_date',
  'extra_accounts_dropped',
]);

export const SAMPLE_FILENAME = 'creator_sample_synthetic.csv';

const SAMPLE_CANDIDATES = [`../../data/${SAMPLE_FILENAME}`, `../data/${SAMPLE_FILENAME}`];

export function bundledSamplePath(): string {
  for (const relative of SAMPLE_CANDIDATES) {
    const path = url.fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error('The bundled sample dataset is missing from this installation.');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function parseCell(column: Column, raw: string): CellValue {
  const value = raw.trim();
  if (value === '') return column === 'has_email' ? false : null;

  if (BOOLEAN_COLUMNS.has(column)) {
    const lowered = value.toLowerCase();
    if (lowered === 'true' || lowered === '1') return true;
    if (lowered === 'false' || lowered === '0') return false;
    return null;
  }

  if (STRING_COLUMNS.has(column)) return value;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseCreators(text: string): CreatorRow[] {
  const [header, ...records] = parseCsv(text);
  if (!header) throw new Error('The creator dataset is empty.');

  const names = header.map((cell) => cell.trim());
  const missing = COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw new Error(`The creator dataset is missing columns: ${missing.join(', ')}.`);
  }

  const index = new Map(names.map((name, position) => [name, position]));

  return records.map((cells) => {
    const row = {} as CreatorRow;
    for (const column of COLUMNS) {
      row[column] = parseCell(column, cells[index.get(column)!] ?? '');
    }
    return row;
  });
}

export const LOAD_FAILURE =
  'The creator dataset could not be loaded. Check that CREATOR_DATASET_PATH points to a readable ' +
  'CSV with the expected columns, or unset it to use the bundled synthetic sample.';

export class CreatorDataset {
  private rows: Promise<CreatorRow[]> | undefined;

  constructor(private readonly customPath: string | undefined) {}

  get isCustom(): boolean {
    return this.customPath !== undefined;
  }

  async load(): Promise<CreatorRow[]> {
    this.rows ??= this.read().catch((error: unknown) => {
      this.rows = undefined;
      throw error;
    });
    return this.rows;
  }

  private async read(): Promise<CreatorRow[]> {
    let text: string;
    try {
      text = await readFile(this.customPath ?? bundledSamplePath(), 'utf8');
    } catch {
      throw new Error(LOAD_FAILURE);
    }

    try {
      return parseCreators(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      throw new Error(`${LOAD_FAILURE} ${reason}`.trim());
    }
  }
}
