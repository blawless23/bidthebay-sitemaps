/**
 * Bid the Bay - daily custom sitemap generator
 * ---------------------------------------------------------------------------
 * Runs as an Airtable Automation "Run script" action.
 *
 *   Base    : Bay Area Bid Board (appsYDZU3JmOp1pbk)
 *   Table   : Projects (tblXwh8XsITy8VsoG)
 *   Trigger : "At scheduled time" - Daily, 2:00 PM, America/Los_Angeles
 *
 * Reads every Projects record natively (no Airtable API key, no REST
 * pagination), resolves exactly ONE canonical URL per record, validates the
 * generated XML, and only then commits it to the GitHub repo that GitHub Pages
 * serves at https://sitemaps.bidthebay.com.
 *
 * Publication is one atomic git commit via the Git Data API: all files flip
 * together or none do. If anything fails validation the script throws before
 * committing, so the previously published sitemap keeps serving untouched.
 * Git history doubles as the audit log and the rollback mechanism.
 *
 * Required automation input variables (left pane of the Run script action):
 *   githubToken   fine-grained PAT with Contents: Read and write on the repo
 *   githubOwner   your GitHub username or org
 *   githubRepo    the repository name, e.g. bidthebay-sitemaps
 *   githubBranch  usually "main"
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Where the actual PAGES live. Every <loc> inside the sitemaps uses this.
const BASE_URL = 'https://www.bidthebay.com';

// Where the sitemap FILES are hosted. Only the index's child <loc> entries use
// this. Google accepts a sitemap on another host when it is referenced from the
// target site's robots.txt, and this subdomain is covered by the
// sc-domain:bidthebay.com Search Console property.
const SITEMAP_HOST = 'https://sitemaps.bidthebay.com';

const TABLE_NAME = 'Projects';
const SITE_TZ = 'America/Los_Angeles';

const F = {
  projectName: 'Project Name',
  owner: 'Owner',
  slug: 'SEO:Slug',
  index: 'SEO:Index',
  partyType: 'Interested Party Type',
  lastModified: 'Last Modified (Data Entry)',
  // Optional manual override. Create this field to pin a multi-category record
  // to one route; the script picks it up automatically when present.
  canonicalOverride: 'SEO:Canonical Type',
};

const ROUTE = {
  construction: 'construction-project-details',
  'professional services': 'professional-services-project-details',
};

const FILES = {
  index: 'sitemap.xml',
  construction: 'sitemap-construction.xml',
  professional: 'sitemap-professional-services.xml',
  static: 'sitemap-static.xml',
};

// Audited public, indexable, self-canonical pages. Every one was verified live.
// Deliberately excluded: /owners (404), /contractor-search (canonical points to
// /construction-projects), /help (canonical points to /login), and all auth,
// error, account and template-root pages.
const STATIC_PAGES = [
  '/', '/construction-projects', '/professional-services-projects',
  '/bay-area-bid-board', '/pricing', '/faq', '/about-us', '/get-started',
  '/terms-of-service', '/privacy-policy',
];

// Safety rails. A run that trips either of these aborts without publishing.
const MIN_EXPECTED_URLS = 1500;   // absolute floor
const MAX_SHRINK_RATIO = 0.05;    // reject a >5% drop vs the last good run

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'checked', 'on']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function normalizePartyTypes(raw) {
  if (raw === null || raw === undefined) return [];
  let values;
  if (typeof raw === 'string') values = raw.split(/[;,]/);
  else if (Array.isArray(raw)) values = raw.map((v) => (v && typeof v === 'object' ? v.name : v));
  else if (typeof raw === 'object') values = [raw.name];
  else values = [String(raw)];

  const out = [];
  for (const v of values) {
    const token = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (token && !out.includes(token)) out.push(token);
  }
  return out.sort();
}

function isIndexable(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

function normalizeOverride(raw) {
  if (!raw) return null;
  let v = raw;
  if (Array.isArray(v)) v = v.length ? v[0] : '';
  if (v && typeof v === 'object') v = v.name;
  const token = String(v || '').trim().toLowerCase();
  if (token.startsWith('construction')) return 'construction';
  if (token.startsWith('professional')) return 'professional services';
  return null;
}

/** UTC ISO timestamp -> RFC 3339 in America/Los_Angeles. */
function toLastmod(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(parts.timeZoneName || '');
  const offset = m ? `${m[1]}${String(m[2]).padStart(2, '0')}:${m[3] || '00'}` : 'Z';
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

// ---------------------------------------------------------------------------
// Routing - one canonical URL per record, never two
// ---------------------------------------------------------------------------

function resolve(record) {
  const recordId = record.id;
  const slug = String(record.getCellValueAsString(F.slug) || '').trim().replace(/^\/+|\/+$/g, '');
  const partyTypes = normalizePartyTypes(record.getCellValue(F.partyType));
  const projectName = record.getCellValueAsString(F.projectName) || '';
  const owner = record.getCellValueAsString(F.owner) || '';
  const lastmod = toLastmod(record.getCellValue(F.lastModified));

  const base = { recordId, slug, projectName, owner, partyTypes, lastmod,
                 included: false, category: null, url: null, reason: null, exception: false };

  if (!isIndexable(record.getCellValue(F.index))) return { ...base, reason: 'seo_index_falsy' };
  if (!recordId) return { ...base, reason: 'missing_record_id', exception: true };
  if (!slug) return { ...base, reason: 'missing_slug', exception: true };
  if (!partyTypes.length) return { ...base, reason: 'missing_interested_party_type', exception: true };

  const hasC = partyTypes.includes('construction');
  const hasP = partyTypes.includes('professional services');

  let category = null;
  let reason = null;
  let exception = false;

  if (hasC && hasP) {
    let override = null;
    try { override = normalizeOverride(record.getCellValue(F.canonicalOverride)); } catch (e) { /* field absent */ }
    category = override || 'construction';
    reason = override ? 'multi_category_manual_override' : 'multi_category_provisional_construction';
    exception = true;
  } else if (hasC) {
    category = 'construction';
  } else if (hasP) {
    category = 'professional services';
  } else {
    // Supplier only, or an unrecognised value. Never guess a route.
    return { ...base, reason: 'unsupported_party_type', exception: true };
  }

  return {
    ...base, included: true, category, reason, exception,
    url: `${BASE_URL}/${ROUTE[category]}/${slug}/r/${recordId}`,
  };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function buildUrlset(entries) {
  const rows = entries.map(({ loc, lastmod }) =>
    '  <url>\n' +
    `    <loc>${xmlEscape(loc)}</loc>\n` +
    (lastmod ? `    <lastmod>${xmlEscape(lastmod)}</lastmod>\n` : '') +
    '  </url>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${NS}">\n${rows.join('\n')}\n</urlset>\n`;
}

function buildIndex(children) {
  const rows = children.map(({ file, lastmod }) =>
    '  <sitemap>\n' +
    `    <loc>${xmlEscape(`${SITEMAP_HOST}/${file}`)}</loc>\n` +
    (lastmod ? `    <lastmod>${xmlEscape(lastmod)}</lastmod>\n` : '') +
    '  </sitemap>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${NS}">\n${rows.join('\n')}\n</sitemapindex>\n`;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Validation - a failure here must prevent publication
// ---------------------------------------------------------------------------

const FORBIDDEN_PATHS = [
  '/login', '/sign-up', '/forgot-password', '/reset-password', '/link-expired',
  '/401', '/404', '/admin', '/dashboard', '/account', '/plan-and-billing',
  '/delete-account', '/saved-project', '/payment-success', '/onboarding',
  '/check-out', '/owners', '/contractor-search', '/help',
];

function validate(files, resolutions) {
  const errors = [];
  const included = resolutions.filter((r) => r.included);
  const locs = [];
  const seenIds = new Map();

  for (const r of included) {
    locs.push(r.url);
    seenIds.set(r.recordId, (seenIds.get(r.recordId) || 0) + 1);
  }

  const dupIds = [...seenIds.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupIds.length) errors.push(`record id under more than one route: ${dupIds.slice(0, 5).join(', ')}`);

  const dupLocs = locs.filter((l, i) => locs.indexOf(l) !== i);
  if (dupLocs.length) errors.push(`duplicate <loc>: ${[...new Set(dupLocs)].slice(0, 5).join(', ')}`);

  for (const loc of locs) {
    if (!loc.startsWith(`${BASE_URL}/`)) errors.push(`loc not under ${BASE_URL}: ${loc}`);
    if (loc.includes('?') || loc.includes('#')) errors.push(`loc has query/fragment: ${loc}`);
  }

  for (const p of STATIC_PAGES) {
    if (FORBIDDEN_PATHS.includes(p)) errors.push(`static page is on the forbidden list: ${p}`);
  }

  for (const [name, xml] of Object.entries(files)) {
    if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) errors.push(`${name}: missing XML declaration`);
    if (!xml.includes(NS)) errors.push(`${name}: missing sitemap namespace`);
    if (xml.includes('<priority>')) errors.push(`${name}: <priority> must not be present`);
    if (xml.includes('<changefreq>')) errors.push(`${name}: <changefreq> must not be present`);
    const opens = (xml.match(/<loc>/g) || []).length;
    const closes = (xml.match(/<\/loc>/g) || []).length;
    if (opens !== closes) errors.push(`${name}: unbalanced <loc> tags`);
    if (opens === 0) errors.push(`${name}: contains zero URLs`);
    if (opens > 50000) errors.push(`${name}: ${opens} URLs exceeds the 50,000 limit`);
  }

  if (included.length < MIN_EXPECTED_URLS) {
    errors.push(`only ${included.length} URLs generated, below the floor of ${MIN_EXPECTED_URLS}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// GitHub publishing - one atomic commit via the Git Data API
// ---------------------------------------------------------------------------

function makeGitHub(token, owner, repo, branch) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  async function call(path, options = {}) {
    const res = await fetch(`${api}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub ${options.method || 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  return {
    /** Read a file's raw text, or null when it does not exist yet. */
    async readFile(path) {
      const res = await fetch(`${api}/contents/${path}?ref=${branch}`, {
        headers: { ...headers, Accept: 'application/vnd.github.raw' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub read ${path} -> ${res.status}`);
      return res.text();
    },

    /** Commit every file in one atomic commit. */
    async commitAll(filesByPath, message) {
      const refRes = await call(`/git/ref/heads/${branch}`);
      const baseSha = (await refRes.json()).object.sha;

      const commitRes = await call(`/git/commits/${baseSha}`);
      const baseTreeSha = (await commitRes.json()).tree.sha;

      const tree = [];
      for (const [path, content] of Object.entries(filesByPath)) {
        const blobRes = await call('/git/blobs', {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'utf-8' }),
        });
        tree.push({ path, mode: '100644', type: 'blob', sha: (await blobRes.json()).sha });
      }

      const treeRes = await call('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree }),
      });
      const newTreeSha = (await treeRes.json()).sha;

      const newCommitRes = await call('/git/commits', {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTreeSha, parents: [baseSha] }),
      });
      const newCommitSha = (await newCommitRes.json()).sha;

      await call(`/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommitSha, force: false }),
      });

      return newCommitSha;
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cfg = input.config();
for (const key of ['githubToken', 'githubOwner', 'githubRepo', 'githubBranch']) {
  if (!cfg[key]) throw new Error(`Missing input variable: ${key}`);
}
const gh = makeGitHub(cfg.githubToken, cfg.githubOwner, cfg.githubRepo, cfg.githubBranch);

const startedAt = new Date().toISOString();
const table = base.getTable(TABLE_NAME);

const fields = [F.projectName, F.owner, F.slug, F.index, F.partyType, F.lastModified];
if (table.fields.some((f) => f.name === F.canonicalOverride)) fields.push(F.canonicalOverride);

// selectRecordsAsync pages through the whole table internally.
const query = await table.selectRecordsAsync({ fields });
const resolutions = query.records.map(resolve);

const totalRecords = resolutions.length;
const included = resolutions.filter((r) => r.included);
const excluded = resolutions.filter((r) => !r.included);
const exceptions = resolutions.filter((r) => r.exception);

const construction = included
  .filter((r) => r.category === 'construction')
  .map((r) => ({ loc: r.url, lastmod: r.lastmod }))
  .sort((a, b) => a.loc.localeCompare(b.loc));

const professional = included
  .filter((r) => r.category === 'professional services')
  .map((r) => ({ loc: r.url, lastmod: r.lastmod }))
  .sort((a, b) => a.loc.localeCompare(b.loc));

const nowStamp = toLastmod(new Date().toISOString());
const newest = (arr) => arr.reduce((m, e) => (e.lastmod && e.lastmod > m ? e.lastmod : m), '') || nowStamp;

const files = {
  [FILES.construction]: buildUrlset(construction),
  [FILES.professional]: buildUrlset(professional),
  [FILES.static]: buildUrlset(STATIC_PAGES.map((p) => ({
    loc: p === '/' ? `${BASE_URL}/` : `${BASE_URL}${p}`, lastmod: nowStamp,
  }))),
  [FILES.index]: buildIndex([
    { file: FILES.construction, lastmod: newest(construction) },
    { file: FILES.professional, lastmod: newest(professional) },
    { file: FILES.static, lastmod: nowStamp },
  ]),
};

const errors = validate(files, resolutions);

// --- Diff against the last published run -----------------------------------
let previousLocs = [];
let previousCount = null;
try {
  const raw = await gh.readFile('manifest.json');
  if (raw) {
    const manifest = JSON.parse(raw);
    previousLocs = Array.isArray(manifest.locs) ? manifest.locs : [];
    previousCount = typeof manifest.urlCount === 'number' ? manifest.urlCount : null;
  }
} catch (e) {
  console.log(`Could not read previous manifest (treating as first run): ${e.message}`);
}

const currentLocs = included.map((r) => r.url);
const prevSet = new Set(previousLocs);
const currSet = new Set(currentLocs);
const addedUrls = currentLocs.filter((l) => !prevSet.has(l));
const removedUrls = previousLocs.filter((l) => !currSet.has(l));

if (previousCount && currentLocs.length < previousCount * (1 - MAX_SHRINK_RATIO)) {
  errors.push(
    `URL count dropped from ${previousCount} to ${currentLocs.length} ` +
    `(> ${MAX_SHRINK_RATIO * 100}%). Refusing to publish a materially smaller sitemap.`
  );
}

// --- Report ----------------------------------------------------------------
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  totalAirtableRecords: totalRecords,
  includedUrls: included.length,
  constructionUrls: construction.length,
  professionalUrls: professional.length,
  staticUrls: STATIC_PAGES.length,
  excludedRecords: excluded.length,
  exclusionsByReason: excluded.reduce((acc, r) => (acc[r.reason] = (acc[r.reason] || 0) + 1, acc), {}),
  multiCategoryExceptions: exceptions.filter((r) => String(r.reason || '').startsWith('multi_category')).length,
  addedUrls: addedUrls.length,
  removedUrls: removedUrls.length,
  addedSample: addedUrls.slice(0, 25),
  removedSample: removedUrls.slice(0, 25),
  previousUrlCount: previousCount,
  validationFailures: errors,
  published: false,
};

console.log(JSON.stringify(report, null, 2));

if (errors.length) {
  output.set('report', report);
  throw new Error(
    'Sitemap validation FAILED - nothing was published, the previous sitemap is unchanged.\n' +
    errors.map((e) => `  - ${e}`).join('\n')
  );
}

// --- Publish atomically ----------------------------------------------------
const reconciliation = resolutions.map((r) => ({
  record_id: r.recordId,
  project_name: r.projectName,
  owner: r.owner,
  interested_party_type: r.partyTypes.join('; '),
  seo_slug: r.slug,
  included: r.included ? 'yes' : 'no',
  canonical_category: r.category || '',
  canonical_url: r.url || '',
  lastmod: r.lastmod || '',
  reason: r.reason || '',
  needs_review: r.exception ? 'yes' : 'no',
}));

// Compact lookup consumed by the Softr canonical-fix snippet. Only the
// Professional Services and excluded record IDs are listed; anything else is
// Construction by definition, which keeps this file around 8 KB rather than
// 250 KB. Served by GitHub Pages with Access-Control-Allow-Origin: *.
const canonicalMap = {
  generatedAt: startedAt,
  ps: included.filter((r) => r.category === 'professional services').map((r) => r.recordId),
  excluded: excluded.map((r) => r.recordId),
};

const payload = {
  ...files,
  'canonical-map.json': JSON.stringify(canonicalMap),
  'reconciliation.csv': toCsv(reconciliation),
  'manifest.json': JSON.stringify({
    generatedAt: startedAt,
    urlCount: currentLocs.length,
    report: { ...report, addedSample: undefined, removedSample: undefined },
    locs: currentLocs,
  }, null, 2),
};

const sha = await gh.commitAll(
  payload,
  `sitemap: ${currentLocs.length} project URLs (+${addedUrls.length}/-${removedUrls.length})`
);

report.published = true;
report.commit = sha;
output.set('report', report);
console.log(
  `Published ${currentLocs.length} project URLs + ${STATIC_PAGES.length} static URLs ` +
  `in commit ${sha.slice(0, 7)}.`
);
