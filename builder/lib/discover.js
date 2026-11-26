'use strict';
// Complete article discovery from public, supported sources. Nothing is skipped silently: every disagreement between sources is reported.
//   1. /blog-search?limit=50&page=N   (JSON, all posts + pages; paginated until total)            -> primary inventory (id, title, description, date, image)
//   2. /posts?page=N                  (native listing, 6/page; paginated until the LAST page)      -> categories + completeness cross-check (reaches the oldest post)
//   3. blog sitemap (via /sitemap.xml index)                                                       -> completeness cross-check (URLs)
//   4. /feed (RSS)                                                                                 -> only a sanity check of the newest items (never the inventory: it lists few items)
const normPath = p => { try { p = new URL(p, 'http://x').pathname; } catch (e) {} p = decodeURIComponent(p).toLowerCase(); return p.length > 1 ? p.replace(/\/+$/, '') : p; };
function parseListing(html) {
  const m = html.match(/"blogPostListing":"((?:[^"\\]|\\.)*)"/); if (!m) return null;
  try { const inner = JSON.parse('"' + m[1].replace(/\\x([0-9a-fA-F]{2})/g, (a, x) => '\\u00' + x) + '"'); const d = JSON.parse(inner); return { posts: d.posts || [], total: (d.pagination && d.pagination.total) || 1, current: d.pagination && d.pagination.current }; } catch (e) { return null; }
}
async function viaSearch(c, log) {
  const rows = []; let total = null, pages = 0; const LIMIT = 50;
  for (let page = 1; page <= 200; page++) { const r = await c.get('/blog-search?limit=' + LIMIT + '&page=' + page, 'application/json'); if (r.status !== 200) throw new Error('/blog-search page ' + page + ' returned HTTP ' + r.status); let j; try { j = JSON.parse(r.body); } catch (e) { throw new Error('/blog-search page ' + page + ' is not JSON'); } if (!Array.isArray(j.data)) throw new Error('/blog-search: unexpected shape'); pages++; if (typeof j.total === 'number') total = j.total; rows.push(...j.data); if (!j.data.length || j.data.length < LIMIT || (total != null && rows.length >= total)) break; }
  if (total != null && rows.length < total) throw new Error('/blog-search returned ' + rows.length + ' of ' + total + ' rows');
  return { rows, total, pages };
}
async function viaListing(c) {
  const posts = []; const pages = []; let last = 1;
  for (let p = 1; p <= last && p <= 500; p++) { const r = await c.get('/posts' + (p > 1 ? '?page=' + p : '')); if (r.status !== 200) throw new Error('listing page ' + p + ' returned HTTP ' + r.status); const l = parseListing(r.body); if (!l) throw new Error('listing page ' + p + ': server state not found'); last = l.total; pages.push({ page: p, n: l.posts.length }); posts.push(...l.posts); }
  return { posts, pages, lastPage: last };
}
async function viaSitemap(c) {
  const r = await c.get('/sitemap.xml'); if (r.status !== 200) return { ok: false, reason: 'sitemap HTTP ' + r.status, urls: [] }; let urls = [];
  const locs = s => [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  if (/<sitemapindex/.test(r.body)) { for (const child of locs(r.body)) { if (!/\/sitemaps\/blog\//.test(child)) continue; const cr = await c.get(child); if (cr.status === 200) urls.push(...locs(cr.body)); } } else urls = locs(r.body);
  return { ok: true, urls: urls.map(normPath) };
}
async function viaFeed(c) { try { const r = await c.get('/feed'); if (r.status !== 200) return { ok: false, links: [] }; return { ok: true, links: [...r.body.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(m => normPath(m[1].trim())) }; } catch (e) { if (e.blocked) throw e; return { ok: false, links: [] }; } }

async function discover(c, log) {
  log = log || (() => {}); const rep = { warnings: [], errors: [], sources: {} };
  const s = await viaSearch(c); const l = await viaListing(c); const sm = await viaSitemap(c); const f = await viaFeed(c);
  const posts = new Map(); const dup = [];
  for (const r of s.rows.filter(x => x.type === 'post' && x.path)) { const k = normPath(r.path); if (posts.has(k)) { dup.push(k); continue; } posts.set(k, { id: r.id, path: k, title: String(r.name || '').replace(/<[^>]+>/g, '').trim(), desc: String(r.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), ts: Date.parse(r.publication_date) || 0, img: (r.image && (typeof r.image === 'string' ? r.image : r.image.path)) || '', thumb: (r.image && r.image.thumbnail) || '', cats: [], src: { search: true, listing: false, sitemap: false } }); }
  rep.sources.search = { rows: s.rows.length, posts: posts.size, pages: s.pages, total: s.total, nonPostRows: s.rows.length - posts.size - dup.length };
  if (dup.length) rep.warnings.push('duplicate canonical paths in /blog-search ignored: ' + dup.join(', '));
  const lp = new Set(); for (const p of l.posts) { const k = normPath(p.path); lp.add(k); let e = posts.get(k); if (!e) { e = { id: p.id, path: k, title: String(p.name || '').trim(), desc: String(p.description || '').trim(), ts: (p.dateTs || 0) * 1000, img: p.image || '', thumb: '', cats: [], src: { search: false, listing: true, sitemap: false } }; posts.set(k, e); rep.warnings.push('in listing but not in /blog-search (indexed anyway): ' + k); } e.src.listing = true; e.cats = (p.categories || []).map(x => ({ slug: String(x.path || '').replace(/^\/?(category\/)?/, ''), name: x.name })); if (!e.img && p.image) e.img = p.image; }
  rep.sources.listing = { pages: l.pages.length, lastPage: l.lastPage, posts: l.posts.length, distinct: lp.size, reachedLastPage: l.pages.length === l.lastPage };
  const smSet = new Set(sm.urls); for (const e of posts.values()) { if (smSet.has(e.path)) e.src.sitemap = true; }
  rep.sources.sitemap = { ok: sm.ok, urls: sm.urls.length, postsFound: [...posts.values()].filter(e => e.src.sitemap).length };
  rep.sources.feed = { ok: f.ok, items: f.links.length };
  // cross-checks (reported, never silent)
  for (const e of posts.values()) { if (!e.src.search) continue; if (!e.src.listing) rep.warnings.push('MISMATCH in /blog-search but not in the paginated listing: ' + e.path); if (sm.ok && !e.src.sitemap) rep.warnings.push('MISMATCH in /blog-search but not in the blog sitemap: ' + e.path); }
  if (l.pages.length !== l.lastPage) rep.errors.push('listing pagination did not reach the last page');
  if (rep.sources.listing.distinct !== l.posts.length) rep.warnings.push('listing contains duplicate posts across pages (' + l.posts.length + ' rows, ' + lp.size + ' distinct)');
  const oldest = [...posts.values()].filter(e => e.ts).sort((a, b) => a.ts - b.ts)[0]; rep.oldest = oldest ? { path: oldest.path, ts: oldest.ts } : null; rep.oldestInListing = oldest ? lp.has(oldest.path) : null;
  if (oldest && !lp.has(oldest.path)) rep.errors.push('the oldest post (' + oldest.path + ') was not reached by listing pagination');
  for (const k of f.links) if (!posts.has(k) && k !== '/') rep.warnings.push('in /feed but not in the inventory: ' + k);
  const list = [...posts.values()].sort((a, b) => (b.ts - a.ts) || (b.id - a.id)); const ids = new Set(); for (const e of list) { if (ids.has(e.id)) rep.errors.push('duplicate article id ' + e.id); ids.add(e.id); }
  rep.count = list.length; return { articles: list, report: rep };
}
module.exports = { discover, normPath, parseListing };
