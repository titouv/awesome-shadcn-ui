/**
 * Script: fill-github-from-website.js
 *
 * Goal
 * - Scan all markdown tables in README.md that include columns `Website` and `Github`.
 * - For rows where `Github` is empty AND `Website` contains a valid URL, fetch the website and
 *   attempt to discover a GitHub repository link.
 * - If found, populate the `Github` cell with `[Link](<repo-url>)` and write the updated README.md.
 *
 * Notes
 * - Uses only Node's built-in HTTP/HTTPS modules. No external deps required.
 * - Follows redirects up to 5 hops.
 * - Picks the first GitHub repo-looking link on the page (https://github.com/<owner>/<repo>...).
 * - Skips rows without a Website URL or when no GitHub link is found.
 *
 * Usage
 *   node scripts/fill-github-from-website.js
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

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

function extractMarkdownUrl(cell) {
  if (!cell) return null;
  const m = cell.match(/\]\(([^)]+)\)/); // [Text](URL)
  if (m && m[1]) return m[1].trim();
  // plain URL fallback
  const plain = cell.match(/https?:\/\/[^\s)]+/i);
  return plain ? plain[0] : null;
}

function normalizeUrlMaybe(urlStr) {
  if (!urlStr) return null;
  try {
    // Add protocol if missing
    if (!/^https?:\/\//i.test(urlStr)) {
      urlStr = 'https://' + urlStr;
    }
    const u = new URL(urlStr);
    return u.toString();
  } catch (_) {
    return null;
  }
}

function isGithubRepoUrl(href) {
  if (!href) return false;
  const m = href.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/i);
  return !!m;
}

function isGithubUrl(href) {
  return /https?:\/\/(?:www\.)?github\.com\//i.test(href);
}

function findGithubLinkInHtml(html) {
  if (!html) return null;
  // Collect all hrefs containing github.com
  const hrefs = new Set();
  // href="..."
  const hrefRegex = /href\s*=\s*"([^"]+)"/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    if (isGithubUrl(href)) hrefs.add(href);
  }
  // href='...'
  const hrefRegexSingle = /href\s*=\s*'([^']+)'/gi;
  while ((match = hrefRegexSingle.exec(html)) !== null) {
    const href = match[1];
    if (isGithubUrl(href)) hrefs.add(href);
  }
  // Raw text URLs
  const rawUrlRegex = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_./-]+/gi;
  while ((match = rawUrlRegex.exec(html)) !== null) {
    hrefs.add(match[0]);
  }

  if (hrefs.size === 0) return null;

  // Prefer repo-looking URLs
  for (const h of hrefs) {
    // Expand protocol-relative links
    const full = h.startsWith('//') ? 'https:' + h : h;
    if (isGithubRepoUrl(full)) return full;
  }
  // Fallback to first any github link
  for (const h of hrefs) {
    return h.startsWith('//') ? 'https:' + h : h;
  }
  return null;
}

function fetchWithRedirects(urlStr, { maxRedirects = 5, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const visited = [];

    function doFetch(currentUrl, redirectsLeft) {
      visited.push(currentUrl);
      const u = new URL(currentUrl);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.get(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + (u.search || ''),
          headers: {
            'User-Agent': 'awesome-shadcn-ui-scraper/1.0 (+https://github.com/birobirobiro/awesome-shadcn-ui) Node.js',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers.location;
          if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
            const nextUrl = new URL(loc, u).toString();
            res.resume(); // discard
            return doFetch(nextUrl, redirectsLeft - 1);
          }
          if (status >= 300 && status < 400 && loc && redirectsLeft <= 0) {
            res.resume();
            return resolve({ ok: false, error: `Too many redirects`, visited });
          }
          if (status < 200 || status >= 400) {
            res.resume();
            return resolve({ ok: false, error: `HTTP ${status}`, visited });
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ ok: true, body: data, visited }));
        }
      );
      req.on('error', (err) => resolve({ ok: false, error: err.message, visited }));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
      });
    }

    doFetch(urlStr, maxRedirects);
  });
}

function parseTables(lines) {
  const tables = [];
  let inTable = false;
  let headerLineCount = 0;
  let websiteCol = -1;
  let githubCol = -1;
  let startIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.startsWith('|');

    if (!inTable && isTableLine) {
      // Possible header
      inTable = true;
      headerLineCount = 1;
      startIndex = i;
      const headerParts = line.split('|').map((p) => p.trim());
      websiteCol = headerParts.findIndex((p) => p.toLowerCase() === 'website');
      githubCol = headerParts.findIndex((p) => p.toLowerCase() === 'github');
      // We still track the table even if columns not present, to skip processing rows
      tables.push({ startIndex, websiteCol, githubCol, rows: [i] });
      continue;
    }

    if (inTable && isTableLine) {
      headerLineCount++;
      tables[tables.length - 1].rows.push(i);
      continue;
    }

    if (inTable && !isTableLine) {
      inTable = false;
      headerLineCount = 0;
      websiteCol = -1;
      githubCol = -1;
      startIndex = -1;
    }
  }

  return tables;
}

async function main() {
  const content = readFile(README_PATH);
  const lines = content.split('\n');
  const tables = parseTables(lines);

  // Collect updates to apply after network fetches
  const updates = [];

  for (const t of tables) {
    const { rows, websiteCol, githubCol } = t;
    if (websiteCol === -1 || githubCol === -1) continue; // table without needed columns
    if (rows.length < 3) continue; // header + separator + data

    // Process data rows (skip first two: header and separator)
    for (let idx = 2; idx < rows.length; idx++) {
      const lineIdx = rows[idx];
      const parts = lines[lineIdx].split('|');

      // Ensure parts large enough
      while (parts.length <= Math.max(websiteCol, githubCol)) parts.push(' ');

      const websiteCell = parts[websiteCol];
      const githubCell = parts[githubCol];
      const websiteUrlRaw = extractMarkdownUrl(websiteCell);
      const githubCellTrim = (githubCell || '').trim();

      // Only attempt when GitHub is empty AND website is present
      if ((!githubCellTrim || githubCellTrim === '') && websiteUrlRaw) {
        const websiteUrl = normalizeUrlMaybe(websiteUrlRaw);
        if (!websiteUrl) continue;

        updates.push({ lineIdx, websiteCol, githubCol, websiteUrl });
      }
    }
  }

  if (updates.length === 0) {
    console.log('No rows require updates (no empty Github with a Website URL).');
    return;
  }

  console.log(`Attempting to fetch ${updates.length} website(s) to discover GitHub links...`);

  let applied = 0;
  for (const up of updates) {
    const { lineIdx, githubCol, websiteUrl } = up;
    console.log(`- Fetching: ${websiteUrl}`);
    try {
      const res = await fetchWithRedirects(websiteUrl);
      if (!res.ok) {
        console.warn(`  Skipped (${res.error || 'request failed'})`);
        continue;
      }
      const found = findGithubLinkInHtml(res.body);
      if (!found) {
        console.warn('  No GitHub link found');
        continue;
      }
      // Update the GitHub cell to `[Link](url)` while preserving other cells
      const parts = lines[lineIdx].split('|');
      while (parts.length <= githubCol) parts.push(' ');
      parts[githubCol] = ` [Link](${found}) `;
      lines[lineIdx] = parts.join('|');
      applied++;
      console.log(`  ✓ Found: ${found}`);
    } catch (err) {
      console.warn(`  Error: ${err.message}`);
    }
  }

  if (applied > 0) {
    writeFile(README_PATH, lines.join('\n'));
    console.log(`Updated README.md. Filled ${applied} GitHub link(s).`);
  } else {
    console.log('No updates applied.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

