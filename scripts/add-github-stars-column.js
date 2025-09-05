/**
 * Script: add-github-stars-column.js
 *
 * Goal
 * - Scan all markdown tables in README.md.
 * - If a table does not already have a "GitHub Stars" column, insert it
 *   (preferably right after the "Github" column; otherwise append at end).
 * - Update all rows by adding an empty cell for that new column.
 * - Write the updated README.md.
 *
 * Usage
 *   node scripts/add-github-stars-column.js
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

// Build a separator cell preserving alignment from a source separator cell
function separatorCellFrom(cell) {
  const trimmed = (cell || '').trim();
  const leftAlign = trimmed.startsWith(':');
  const rightAlign = trimmed.endsWith(':');
  const core = '---';
  return `${leftAlign ? ':' : ''}${core}${rightAlign ? ':' : ''}`;
}

function main() {
  const content = readFile(README_PATH);
  const lines = content.split('\n');

  let inTable = false;
  let headerLineCount = 0;
  let modifyThisTable = false;
  let githubColIndex = -1;
  let starsColIndex = -1;
  let insertIndex = -1; // Where to insert the new column

  let tablesModified = 0;
  let rowsTouched = 0;

  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const isTableLine = line.startsWith('|');

    // Reset when leaving a table
    if (!isTableLine && inTable) {
      inTable = false;
      headerLineCount = 0;
      modifyThisTable = false;
      githubColIndex = -1;
      starsColIndex = -1;
      insertIndex = -1;
    }

    if (!isTableLine) {
      out.push(line);
      continue;
    }

    // We are on a table line
    if (!inTable) {
      // Header row
      inTable = true;
      headerLineCount = 1;

      const headerPartsRaw = line.split('|');
      const headerPartsTrim = headerPartsRaw.map((p) => p.trim());

      // Detect important columns (case-insensitive)
      const idxOf = (name) => headerPartsTrim.findIndex((p) => p.toLowerCase() === name.toLowerCase());
      githubColIndex = idxOf('Github'); // support casing used in this repo
      if (githubColIndex === -1) githubColIndex = idxOf('GitHub');
      starsColIndex = idxOf('GitHub Stars');

      // If already has GitHub Stars, do not modify this table
      if (starsColIndex !== -1) {
        modifyThisTable = false;
        out.push(line);
        continue;
      }

      // Decide where to insert new column
      if (githubColIndex !== -1) {
        insertIndex = githubColIndex + 1; // right after Github
      } else {
        // Append before trailing empty part (to keep closing '|')
        insertIndex = Math.max(0, headerPartsRaw.length - 1);
      }

      // Insert header cell
      const newHeaderParts = headerPartsRaw.slice();
      newHeaderParts.splice(insertIndex, 0, ' GitHub Stars ');
      out.push(newHeaderParts.join('|'));
      modifyThisTable = true;
      tablesModified++;
      rowsTouched++;
      continue;
    }

    headerLineCount++;

    // Separator row (second line in table)
    if (headerLineCount === 2) {
      if (!modifyThisTable) {
        out.push(line);
        continue;
      }

      const sepParts = line.split('|');
      // Choose reference alignment: Github column if present, else last real column
      const refIndex = githubColIndex !== -1 ? githubColIndex : Math.max(0, sepParts.length - 2);
      const sourceCell = sepParts[refIndex] || ' --- ';
      const newSepCell = ` ${separatorCellFrom(sourceCell)} `;
      sepParts.splice(insertIndex, 0, newSepCell);
      out.push(sepParts.join('|'));
      rowsTouched++;
      continue;
    }

    // Data rows
    if (!modifyThisTable) {
      out.push(line);
      continue;
    }

    const parts = line.split('|');
    parts.splice(insertIndex, 0, ' '); // empty cell
    out.push(parts.join('|'));
    rowsTouched++;
  }

  if (tablesModified === 0) {
    console.log('No tables required a GitHub Stars column. No changes made.');
    return;
  }

  writeFile(README_PATH, out.join('\n'));
  console.log(`Added \"GitHub Stars\" column to ${tablesModified} table(s). Updated ${rowsTouched} line(s).`);
}

main();

