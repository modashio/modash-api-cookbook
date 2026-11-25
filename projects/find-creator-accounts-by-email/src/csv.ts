import { readFileSync } from 'node:fs';

interface CsvRecord {
  /** The file line where the row starts. The header is line 1. */
  line: number;
  cells: string[];
}

export interface Cell {
  line: number;
  value: string;
}

/** The cells of one column, by its header name. Rows with every cell empty are skipped. Errors call the file `name`. */
export function readColumn(path: string, column: string, name = path): Cell[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`could not read ${name}: ${(error as Error).message}`);
  }
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
  const [header, ...rows] = records;
  const columns = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
  const index = columns.indexOf(column.trim().toLowerCase());
  if (index < 0) {
    const found = columns.filter((c) => c !== '').join(', ') || 'none';
    throw new Error(`${name} has no column named "${column}". Its columns: ${found}. Pass --column <name> to pick one. The file must be comma-separated.`);
  }
  const cells = rows.filter((r) => r.cells.some((c) => c.trim() !== '')).map((r) => ({ line: r.line, value: r.cells[index] ?? '' }));
  if (cells.length === 0) throw new Error(`${name} has no rows`);
  return cells;
}

export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const lineBreak = ch === '\n' || (ch === '\r' && text[i + 1] !== '\n');
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      if (lineBreak) {
        line += 1;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      cells.push(field);
      records.push({ line: start, cells });
      cells = [];
      field = '';
      line += 1;
      start = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('a quoted field never closes');
  if (field !== '' || cells.length > 0) {
    cells.push(field);
    records.push({ line: start, cells });
  }
  return records;
}
