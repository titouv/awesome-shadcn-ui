/**
 * Script: fill-github-stars.js
 *
 * Goal
 * - For every markdown table in README.md, for rows that have a GitHub link
 *   in the `Github` column, fetch the repository star count and store it in
 *   the `GitHub Stars` column.
 * - If a table is missing the `GitHub Stars` column, insert it (right after
 *   the `Github` column when present; otherwise append it).
 *
 * Notes
 * - Uses only Node's built-in HTTPS module; no external dependencies.
 * - Fetches stars via GitHub REST API: https://api.github.com/repos/{owner}/{repo}
 * - Supports optional `GITHUB_TOKEN` env var to increase rate limits.
 * - Caches results per repo within the run to avoid duplicate requests.
 *
 * Usage
 *   node scripts/fill-github-stars.js
 */

const fs = require('fs');
const https = require('https');

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

function separatorCellFrom(cell) {
  const trimmed = (cell || '').trim();
  const leftAlign = trimmed.startsWith(':');
  const rightAlign = trimmed.endsWith(':');
  const core = '---';
  return `${leftAlign ? ':' : ''}${core}${rightAlign ? ':' : ''}`;
}

function extractMarkdownUrl(cell) {
  if (!cell) return null;
  const m = cell.match(/\]\(([^)]+)\)/); // [Text](URL)
  if (m && m[1]) return m[1].trim();
  const plain = cell.match(/https?:\/\/[^\s)]+/i);
  return plain ? plain[0] : null;
}

function parseGithubRepo(url) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/i);
  if (!m) return null;
  const owner = m[1];
  let repo = m[2];
  // strip .git if present
  repo = repo.replace(/\.git$/i, '');
  return `${owner}/${repo}`;
}

function httpsGetJson({ hostname, path, token, redirectsLeft = 5 }) {
  return new Promise((resolve) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'awesome-shadcn-ui-stars/1.0 (+https://github.com/birobirobiro/awesome-shadcn-ui) Node.js',
        'Accept': 'application/vnd.github+json',
      },
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        const remaining = res.headers['x-ratelimit-remaining'];
        const reset = res.headers['x-ratelimit-reset'];
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          try {
            const loc = res.headers.location;
            let nextUrl = new URL(loc, 'https://api.github.com');
            return resolve(
              httpsGetJson({ hostname: nextUrl.hostname, path: nextUrl.pathname + nextUrl.search, token, redirectsLeft: redirectsLeft - 1 })
            );
          } catch (e) {
            return resolve({ ok: false, status, error: 'redirect-parse-failed' });
          }
        }
        if (status === 403 && remaining === '0') {
          return resolve({ ok: false, status, error: 'rate-limited', reset });
        }
        if (status >= 200 && status < 300) {
          try {
            const json = JSON.parse(data);
            return resolve({ ok: true, json, status, remaining, reset });
          } catch (e) {
            return resolve({ ok: false, status, error: 'invalid-json' });
          }
        }
        return resolve({ ok: false, status, error: data });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

async function githubApiFetchRepo(repo, token) {
  // Normalize to lowercase to avoid some 301s; GitHub is case-insensitive.
  const [owner, name] = repo.split('/');
  const normalized = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const res = await httpsGetJson({ hostname: 'api.github.com', path: `/repos/${normalized}`, token });
  if (!res.ok) return res;
  return { ok: true, stars: res.json.stargazers_count ?? null };
}

function findTables(lines) {
  const tables = [];
  let inTable = false;
  let startIndex = -1;
  let headerLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.startsWith('|');
    if (!inTable && isTableLine) {
      inTable = true;
      startIndex = i;
      headerLine = i;
      tables.push({ startIndex, headerLine, rows: [i] });
      continue;
    }
    if (inTable && isTableLine) {
      tables[tables.length - 1].rows.push(i);
      continue;
    }
    if (inTable && !isTableLine) {
      inTable = false;
      startIndex = -1;
      headerLine = -1;
    }
  }
  return tables;
}

async function main() {
  const token = process.env.GITHUB_TOKEN || '';
  const content = readFile(README_PATH);
  const lines = content.split('\n');

  const tables = findTables(lines);

  let tablesTouched = 0;
  let rowsUpdated = 0;

  // Per-run cache: repo -> stars
  const cache = new Map();

  // Collect fetch jobs so we can do API calls after structural edits
  const jobs = [];

  for (const t of tables) {
    const { rows } = t;
    if (rows.length < 3) continue; // header + separator + at least one row

    const header = lines[rows[0]];
    const headerPartsRaw = header.split('|');
    const headerPartsTrim = headerPartsRaw.map((p) => p.trim());
    const idxOf = (name) => headerPartsTrim.findIndex((p) => p.toLowerCase() === name.toLowerCase());
    let githubCol = idxOf('Github');
    if (githubCol === -1) githubCol = idxOf('GitHub');
    let starsCol = idxOf('GitHub Stars');

    // If no Github column, nothing to do for this table
    if (githubCol === -1) continue;

    // Ensure stars column exists; if missing, insert right after Github
    let insertIndex = starsCol;
    let modifiedStructure = false;
    if (starsCol === -1) {
      insertIndex = githubCol + 1;
      // Insert header cell
      const newHeader = headerPartsRaw.slice();
      newHeader.splice(insertIndex, 0, ' GitHub Stars ');
      lines[rows[0]] = newHeader.join('|');

      // Separator row alignment – mirror Github col if possible
      const sepParts = lines[rows[1]].split('|');
      const sourceCell = sepParts[githubCol] || ' --- ';
      const newSepCell = ` ${separatorCellFrom(sourceCell)} `;
      sepParts.splice(insertIndex, 0, newSepCell);
      lines[rows[1]] = sepParts.join('|');

      // Insert blank cells in data rows
      for (let r = 2; r < rows.length; r++) {
        const ri = rows[r];
        const parts = lines[ri].split('|');
        parts.splice(insertIndex, 0, ' ');
        lines[ri] = parts.join('|');
      }

      starsCol = insertIndex;
      modifiedStructure = true;
      tablesTouched++;
    }

    // Now iterate data rows and schedule fetch jobs
    for (let r = 2; r < rows.length; r++) {
      const ri = rows[r];
      const parts = lines[ri].split('|');
      while (parts.length <= Math.max(githubCol, starsCol)) parts.push(' ');
      const githubCell = parts[githubCol];
      const url = extractMarkdownUrl(githubCell);
      const repo = parseGithubRepo(url);
      if (!repo) continue;

      jobs.push({ lineIndex: ri, starsCol, repo });
    }

    if (modifiedStructure) {
      // refresh headerParts for any subsequent logic (not strictly needed now)
    }
  }

  if (jobs.length === 0) {
    console.log('No GitHub links found in tables or no tables require updates.');
    if (tablesTouched > 0) writeFile(README_PATH, lines.join('\n'));
    return;
  }

  console.log(`Fetching stars for ${jobs.length} row(s)...`);

  let apiCalls = 0;
  let hitRateLimit = false;
  for (const job of jobs) {
    const { lineIndex, starsCol, repo } = job;
    let stars = cache.get(repo);
    if (stars == null) {
      const res = await githubApiFetchRepo(repo, token);
      apiCalls++;
      if (!res.ok) {
        if (res.error === 'rate-limited') {
          hitRateLimit = true;
          const resetTs = res.reset ? Number(res.reset) * 1000 : null;
          const waitMs = resetTs ? Math.max(0, resetTs - Date.now()) : null;
          const waitMin = waitMs != null ? Math.ceil(waitMs / 60000) : 'unknown';
          console.warn(`- Rate limit reached. Try setting GITHUB_TOKEN or retry in ~${waitMin} min.`);
          break;
        }
        console.warn(`- ${repo}: failed (${res.status || res.error || 'error'})`);
        continue;
      }
      stars = typeof res.stars === 'number' ? res.stars : null;
      cache.set(repo, stars);
    }
    if (stars == null) continue;

    const parts = lines[lineIndex].split('|');
    while (parts.length <= starsCol) parts.push(' ');
    parts[starsCol] = ` ${String(stars)} `;
    lines[lineIndex] = parts.join('|');
    rowsUpdated++;
  }

  if (rowsUpdated > 0 || tablesTouched > 0) {
    writeFile(README_PATH, lines.join('\n'));
  }

  console.log(`Done. Tables touched: ${tablesTouched}. Rows updated: ${rowsUpdated}. API calls: ${apiCalls}.`);
  if (hitRateLimit) {
    console.log('Hint: export GITHUB_TOKEN=your_token to increase rate limits.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
