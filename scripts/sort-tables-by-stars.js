/**
 * Script: sort-tables-by-stars.js
 *
 * Goal
 * - Find every markdown table in README.md that has a "GitHub Stars" column.
 * - Sort each table's data rows by the numeric star count (descending).
 * - Rows with missing or non-numeric star values are placed at the end.
 * - Preserve headers, separators, and row content/spacing as-is; only reorder rows.
 *
 * Usage
 *   node scripts/sort-tables-by-stars.js
 */

const fs = require('fs');

const README_PATH = 'README.md';

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Error reading ${path}: ${err.message}`);
    process.exit(1);
  }
}

function writeFile(path, content) {
  try {
    fs.writeFileSync(path, content);
  } catch (err) {
    console.error(`Error writing ${path}: ${err.message}`);
    process.exit(1);
  }
}

function findTables(lines) {
  const tables = [];
  let inTable = false;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.startsWith('|');

    if (!inTable && isTableLine) {
      inTable = true;
      current = { startIndex: i, rows: [i] };
      tables.push(current);
      continue;
    }
    if (inTable && isTableLine) {
      current.rows.push(i);
      continue;
    }
    if (inTable && !isTableLine) {
      inTable = false;
      current = null;
    }
  }
  return tables;
}

function parseStars(cellRaw) {
  if (!cellRaw) return null;
  const s = String(cellRaw).trim();
  if (!s) return null;
  // Normalize separators and common suffixes like 1.2k
  const normalized = s.replace(/,/g, '').toLowerCase();
  // ignore markdown pipes or surrounding spaces – we receive a cell string already
  // Convert 1.2k -> 1200, 3k -> 3000
  const mK = normalized.match(/^([0-9]*\.?[0-9]+)\s*k$/);
  if (mK) {
    const val = parseFloat(mK[1]);
    if (!Number.isNaN(val)) return Math.round(val * 1000);
  }
  const n = Number(normalized);
  if (Number.isFinite(n)) return n;
  return null;
}

function main() {
  const content = readFile(README_PATH);
  const lines = content.split('\n');

  const tables = findTables(lines);
  let tablesProcessed = 0;
  let tablesChanged = 0;

  for (const t of tables) {
    const rows = t.rows;
    if (!rows || rows.length < 3) continue; // need header + separator + at least one data row

    const header = lines[rows[0]];
    const headerPartsTrim = header.split('|').map((p) => p.trim());
    const idxOf = (name) => headerPartsTrim.findIndex((p) => p.toLowerCase() === name.toLowerCase());
    const starsCol = idxOf('GitHub Stars');
    if (starsCol === -1) continue; // nothing to sort by

    const dataRowIndexes = rows.slice(2); // skip header and separator
    if (dataRowIndexes.length === 0) continue;

    tablesProcessed++;

    // Prepare sortable entries with stable index
    const entries = dataRowIndexes.map((ri, i) => {
      const parts = lines[ri].split('|');
      const starCell = parts[starsCol] || '';
      const stars = parseStars(starCell);
      return { ri, i, stars, line: lines[ri] };
    });

    // Determine if already sorted to avoid unnecessary writes
    const sorted = entries.slice().sort((a, b) => {
      const aNull = a.stars == null;
      const bNull = b.stars == null;
      if (aNull && bNull) return a.i - b.i; // keep original order
      if (aNull) return 1; // a after b
      if (bNull) return -1; // a before b
      if (b.stars !== a.stars) return b.stars - a.stars; // desc
      return a.i - b.i; // stable
    });

    let changed = false;
    for (let j = 0; j < entries.length; j++) {
      if (sorted[j].ri !== entries[j].ri) {
        changed = true;
        break;
      }
    }

    if (!changed) continue;

    // Apply new order
    for (let j = 0; j < sorted.length; j++) {
      const targetLineIndex = dataRowIndexes[j];
      lines[targetLineIndex] = sorted[j].line;
    }
    tablesChanged++;
  }

  if (tablesChanged > 0) {
    writeFile(README_PATH, lines.join('\n'));
  }

  console.log(
    `Done. Tables processed: ${tablesProcessed}. Tables changed: ${tablesChanged}.`
  );
}

main();

