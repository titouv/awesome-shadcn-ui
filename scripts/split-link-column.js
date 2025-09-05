const fs = require('fs');

const path = 'README.md';
let content;
try {
  content = fs.readFileSync(path, 'utf8');
} catch (error) {
  console.error(`Error reading README.md: ${error.message}`);
  process.exit(1);
}

const lines = content.split('\n');

let inTable = false;
let headerLineCount = 0;
let linkColumnIndex = -1;
let tableHasLinkColumn = false;
let changesCount = 0;

// Helper: build a simple separator cell
function separatorCellFrom(cell) {
  const trimmed = cell.trim();
  // if original had alignment like :--- or ---: or :---:
  const leftAlign = trimmed.startsWith(':');
  const rightAlign = trimmed.endsWith(':');
  const core = '---';
  return `${leftAlign ? ':' : ''}${core}${rightAlign ? ':' : ''}`;
}

// Helper: is GitHub link
function isGithubLink(mdCell) {
  return /(https?:\/\/)?(www\.)?github\.com\//i.test(mdCell);
}

const updatedLines = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Reset table state on section headers or blank lines between tables
  if (line.startsWith('## ') || (!line.startsWith('|') && inTable)) {
    inTable = false;
    headerLineCount = 0;
    linkColumnIndex = -1;
    tableHasLinkColumn = false;
  }

  if (!line.startsWith('|')) {
    updatedLines.push(line);
    continue;
  }

  // We're on a table line
  if (!inTable) {
    // Header row
    inTable = true;
    headerLineCount = 1;

    const headerPartsRaw = line.split('|');
    const headerPartsTrimmed = headerPartsRaw.map((p) => p.trim());
    linkColumnIndex = headerPartsTrimmed.findIndex((p) => p === 'Link');
    tableHasLinkColumn = linkColumnIndex > -1;

    if (!tableHasLinkColumn) {
      // Not a target table
      updatedLines.push(line);
      continue;
    }

    // Replace the header cell 'Link' with 'Website' and insert 'Github' right after
    const newHeaderParts = headerPartsRaw.slice();
    newHeaderParts[linkColumnIndex] = ' Website ';
    newHeaderParts.splice(linkColumnIndex + 1, 0, ' Github ');

    updatedLines.push(newHeaderParts.join('|'));
    changesCount++;
    continue;
  }

  headerLineCount++;

  // Header separator line (second line in the table)
  if (headerLineCount === 2) {
    if (!tableHasLinkColumn) {
      updatedLines.push(line);
      continue;
    }

    // Duplicate the separator cell for the new column
    const sepParts = line.split('|');
    // Ensure there is a part at linkColumnIndex
    while (sepParts.length <= linkColumnIndex + 1) sepParts.push('');
    const sourceCell = sepParts[linkColumnIndex];
    const newSepCell = ` ${separatorCellFrom(sourceCell)} `;
    sepParts.splice(linkColumnIndex + 1, 0, newSepCell);
    updatedLines.push(sepParts.join('|'));
    changesCount++;
    continue;
  }

  // Data rows
  if (!tableHasLinkColumn) {
    updatedLines.push(line);
    continue;
  }

  const parts = line.split('|');
  // Make sure parts array is large enough
  while (parts.length <= linkColumnIndex + 1) parts.push('');

  const linkCell = parts[linkColumnIndex];
  const linkCellTrimmed = linkCell.trim();

  // Insert a new cell for the new column right after the original link column
  // and move the content depending on whether it's a GitHub link.
  let websiteCell = ' ';
  let githubCell = ' ';

  if (linkCellTrimmed) {
    if (isGithubLink(linkCellTrimmed)) {
      githubCell = ` ${linkCellTrimmed} `;
    } else {
      websiteCell = ` ${linkCellTrimmed} `;
    }
  }

  // Set original column to Website and the inserted one to Github
  parts[linkColumnIndex] = websiteCell;
  parts.splice(linkColumnIndex + 1, 0, githubCell);

  updatedLines.push(parts.join('|'));
  if (linkCellTrimmed) changesCount++;
}

if (changesCount === 0) {
  console.log('No changes needed.');
  process.exit(0);
}

try {
  fs.writeFileSync(path, updatedLines.join('\n'));
  console.log(`Updated README.md. Changes applied: ${changesCount}`);
} catch (err) {
  console.error(`Error writing README.md: ${err.message}`);
  process.exit(1);
}

