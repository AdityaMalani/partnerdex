/**
 * Minimal RFC4180-ish CSV reader — quoted fields, escaped quotes, CRLF/LF.
 * No dependency; contacts import is a flat table of strings.
 */

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parseRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0]!.map((header) => header.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < records.length; i++) {
    const cells = records[i]!;
    // Skip trailing blank lines.
    if (cells.length === 1 && cells[0] === '') continue;

    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]!;
      if (!key) continue;
      row[key] = (cells[c] ?? '').trim();
    }
    rows.push(row);
  }

  return { headers, rows };
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') {
      // Swallow CR; LF (or end) ends the record.
      continue;
    }
    field += ch;
  }

  // Last field / row when the file does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  return records;
}
