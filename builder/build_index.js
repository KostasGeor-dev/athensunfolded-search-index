#!/usr/bin/env node
'use strict';
// Athens Unfolded search index builder (Node >= 18, no dependencies).
//   node builder/build_index.js --base https://www.athensunfolded.com --out dist [--pace 1500] [--allow-shrink] [--min-chars 300]
// Exit codes: 0 = new index published (or unchanged), 2 = build rejected (last good index left untouched), 3 = blocked by the server / network failure (nothing changed).
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { Client } = require('./lib/http'); const { discover, normPath } = require('./lib/discover'); const { extractArticle } = require('./lib/html'); const E = require('../engine/au-search-engine.js');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const BASE = arg('base', 'https://www.athensunfolded.com'), OUT = path.resolve(arg('out', 'dist')), PACE = +arg('pace', 1500), MIN_CHARS = +arg('min-chars', 300), MAX_BYTES = +arg('max-bytes', 8 * 1024 * 1024), ALLOW_SHRINK = !!arg('allow-shrink', false), KEEP = +arg('keep', 5);
const sha = b => crypto.createHash('sha256').update(b).digest('hex'); const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

async function run() {
  const t0 = Date.now(); fs.mkdirSync(OUT, { recursive: true }); const c = new Client({ base: BASE, pace: PACE }); const report = { builder: 'au-search-builder/2.0', base: BASE, started: new Date().toISOString(), warnings: [], errors: [], changes: { added: [], updated: [], removed: [], moved: [], retitled: [], recategorised: [] }, failed: [] };
  const prevManifest = readJSON(path.join(OUT, 'manifest.json')); const prev = prevManifest ? readJSON(path.join(OUT, prevManifest.file)) : null; const prevById = new Map(); if (prev) prev.docs.forEach(d => prevById.set(d.id, d));
  // 1. discovery
  log('discovering articles…'); const { articles, report: dr } = await discover(c, log); report.discovery = dr; report.warnings.push(...dr.warnings); report.errors.push(...dr.errors); log('inventory:', articles.length, 'published articles; warnings', dr.warnings.length, 'errors', dr.errors.length);
  if (dr.errors.length) return reject(report, 'discovery errors: ' + dr.errors.join('; '));
  // 2. fetch + extract every article (full coverage; paced; no per-visitor cost)
  const items = []; const textHash = {};
  for (const a of articles) {
    let r; try { r = await c.get(a.path); } catch (e) { if (e.blocked) throw e; report.failed.push({ path: a.path, reason: String(e.message) }); continue; }
    if (r.status !== 200) { report.failed.push({ path: a.path, reason: 'HTTP ' + r.status }); continue; }
    const x = extractArticle(r.body); if (!x.hasProse) { report.failed.push({ path: a.path, reason: 'article body container (.jn-prose) not found' }); continue; }
    const canon = x.canonical ? normPath(x.canonical) : a.path; if (canon !== a.path) report.warnings.push('canonical differs from listed path: ' + a.path + ' -> ' + canon + ' (indexed under the canonical URL)');
    if (x.robots && /noindex/i.test(x.robots)) report.warnings.push('article is marked noindex (indexed for on-site search): ' + a.path);
    const chars = x.sections.reduce((n, s) => n + s.text.length, 0); if (chars < MIN_CHARS) { report.failed.push({ path: a.path, reason: 'article text too short (' + chars + ' chars)' }); continue; }
    items.push({ id: a.id, path: canon, title: a.title || (x.title || '').replace(/\s*[|–-]\s*Athens Unfolded.*$/, ''), desc: a.desc || x.description || '', ts: a.ts, img: a.img, thumb: a.thumb, cats: a.cats, sections: x.sections, chars }); textHash[a.id] = sha(JSON.stringify([a.title, a.desc, a.cats, x.sections]));
    if (items.length % 10 === 0) log('  fetched', items.length + report.failed.length, 'of', articles.length);
  }
  if (report.failed.length) return reject(report, report.failed.length + ' article(s) could not be read; refusing to publish an incomplete index: ' + report.failed.map(f => f.path + ' (' + f.reason + ')').join('; '));
  // 3. changes vs previous generation
  const curIds = new Set(items.map(i => i.id));
  for (const i of items) { const p = prevById.get(i.id); if (!p) report.changes.added.push(i.path); else { if (p.p !== i.path) report.changes.moved.push(p.p + ' -> ' + i.path); if (p.t !== i.title) report.changes.retitled.push(i.path); const pc = JSON.stringify((p.c || []).map(ix => prev.cats[ix].slug).sort()), nc = JSON.stringify(i.cats.map(x => x.slug).sort()); if (pc !== nc) report.changes.recategorised.push(i.path); if (prevManifest && prevManifest.textHashes && prevManifest.textHashes[i.id] !== textHash[i.id]) report.changes.updated.push(i.path); } }
  for (const p of prevById.values()) if (!curIds.has(p.id)) report.changes.removed.push(p.p);
  const shrinkLimit = Math.max(2, Math.floor(0.2 * prevById.size)); if (!ALLOW_SHRINK && prevById.size && report.changes.removed.length > shrinkLimit) return reject(report, 'suspicious shrink: ' + report.changes.removed.length + ' of ' + prevById.size + ' articles disappeared (limit ' + shrinkLimit + '); re-run with --allow-shrink if this is intended');
  // 4. build + validate
  const gen = new Date().toISOString(); const index = E.build(items, { articles: items.length, base: BASE, builder: report.builder }); const json = JSON.stringify(index); const bytes = Buffer.byteLength(json); const gz = zlib.gzipSync(json, { level: 9 }).length; const hash = sha(json);
  const problems = validate(index, items, articles, bytes, report.warnings); if (problems.length) return reject(report, 'validation failed: ' + problems.join('; '));
  // 5. publish atomically (files first, manifest last)
  const file = 'search-index.' + hash.slice(0, 10) + '.json'; const man = { v: 2, generation: gen, file, sha256: hash, bytes, gzBytes: gz, articles: items.length, categories: index.cats.length, terms: Object.keys(index.terms).length, built: report.started, durationMs: Date.now() - t0, requests: c.requests, sourceBytes: c.bytes, sources: dr.sources, previous: prevManifest ? { generation: prevManifest.generation, file: prevManifest.file, articles: prevManifest.articles } : null, warnings: report.warnings.length, textHashes: textHash, verifiedAt: new Date().toISOString() };
  if (prevManifest && prevManifest.sha256 === hash) { log('index unchanged (' + hash.slice(0, 10) + '): keeping generation', prevManifest.generation); report.status = 'unchanged'; { const hb = Object.assign({}, prevManifest, { verifiedAt: new Date().toISOString() }); const tmpHb = path.join(OUT, '.tmp-heartbeat.json'); fs.writeFileSync(tmpHb, JSON.stringify(hb)); fs.renameSync(tmpHb, path.join(OUT, 'manifest.json')); } finishLog(report, man); return 0; }
  const tmp = path.join(OUT, '.tmp-' + hash.slice(0, 8)); fs.mkdirSync(tmp, { recursive: true });
  const slim = { v: 2, generation: gen, file, sha256: hash, articles: items.length, bytes }; const safe = JSON.stringify({ manifest: slim, index }).split('<').join('\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  fs.writeFileSync(path.join(tmp, 'systeme-page-block.html'), '<meta name="robots" content="noindex,nofollow">\n<p style="font:16px/1.5 system-ui,sans-serif;padding:24px;color:#444">Machine-readable search index for the Athens Unfolded article search (generation ' + gen + ', ' + items.length + ' articles). This page is not meant to be read.</p>\n<script type="application/json" id="au-search-index">' + safe + '</script>\n');
  fs.writeFileSync(path.join(tmp, file), json); fs.writeFileSync(path.join(tmp, 'search-index.json'), json); fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(man)); fs.writeFileSync(path.join(tmp, 'changes.json'), JSON.stringify({ generation: gen, ...report.changes }, null, 1));
  fs.mkdirSync(path.join(OUT, 'history'), { recursive: true }); if (prevManifest) { try { fs.copyFileSync(path.join(OUT, prevManifest.file), path.join(OUT, 'history', prevManifest.file)); fs.copyFileSync(path.join(OUT, 'manifest.json'), path.join(OUT, 'history', 'manifest.' + prevManifest.generation.replace(/[:.]/g, '-') + '.json')); } catch (e) {} }
  for (const f of [file, 'search-index.json', 'systeme-page-block.html', 'changes.json', 'manifest.json']) fs.renameSync(path.join(tmp, f), path.join(OUT, f)); fs.rmSync(tmp, { recursive: true, force: true });
  prune(OUT, file, KEEP); report.status = 'published'; report.manifest = man; finishLog(report, man); log('PUBLISHED', file, items.length + ' articles,', bytes, 'bytes (' + gz + ' gzip),', man.terms, 'terms,', Date.now() - t0, 'ms'); return 0;
}
function validate(index, items, inventory, bytes, warnings) {
  const p = []; const eng = (() => { try { return E.load(JSON.parse(JSON.stringify(index))); } catch (e) { p.push('index cannot be loaded: ' + e.message); return null; } })(); if (!eng) return p;
  const inv = new Set(inventory.map(a => a.id)), idx = new Set(index.docs.map(d => d.id)); const missing = [...inv].filter(i => !idx.has(i)), extra = [...idx].filter(i => !inv.has(i)); if (missing.length || extra.length) p.push('completeness: inventory ' + inv.size + ' vs indexed ' + idx.size + ' (missing ' + missing.join(',') + '; extra ' + extra.join(',') + ')');
  const paths = new Set(); for (const d of index.docs) { if (paths.has(d.p)) p.push('duplicate path ' + d.p); paths.add(d.p); if (!d.id || !d.p || !d.t) p.push('incomplete record ' + JSON.stringify([d.id, d.p])); }
  if (bytes > MAX_BYTES) p.push('index too large (' + bytes + ' bytes > ' + MAX_BYTES + ')');
  const tc = {}; index.docs.forEach(d => { const k = E.norm(d.t); tc[k] = (tc[k] || 0) + 1; }); let miss = 0; for (const d of index.docs) { const r = eng.search(d.t); if (!r.results.slice(0, 5).some(x => x.doc.id === d.id) && tc[E.norm(d.t)] === 1) miss++; }
  const dupT = Object.keys(tc).filter(k => tc[k] > 1); if (dupT.length) warnings.push(dupT.length + ' title(s) are identical after normalisation, so search cannot rank those articles apart: ' + dupT.slice(0, 3).join(' | '));
  if (miss) p.push('self-retrieval check: ' + miss + ' article(s) are not in the top 5 for their own title');
  return p;
}
function prune(out, current, keep) { const h = path.join(out, 'history'); try { const files = fs.readdirSync(h).filter(f => f.startsWith('search-index.')).map(f => ({ f, t: fs.statSync(path.join(h, f)).mtimeMs })).sort((a, b) => b.t - a.t); files.slice(keep).forEach(x => fs.rmSync(path.join(h, x.f), { force: true })); } catch (e) {} for (const f of fs.readdirSync(out)) if (/^search-index\.[0-9a-f]{10}\.json$/.test(f) && f !== current) { try { fs.rmSync(path.join(out, f), { force: true }); } catch (e) {} } }
function finishLog(report, man) { report.finished = new Date().toISOString(); fs.writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify({ ...report, manifest: undefined, manifestSummary: { file: man.file, articles: man.articles, bytes: man.bytes, gzBytes: man.gzBytes, terms: man.terms, durationMs: man.durationMs } }, null, 1)); fs.appendFileSync(path.join(OUT, 'build-log.ndjson'), JSON.stringify({ at: report.finished, status: report.status, articles: man.articles, file: man.file, added: report.changes.added.length, updated: report.changes.updated.length, removed: report.changes.removed.length, warnings: report.warnings.length }) + '\n'); }
function reject(report, why) { report.status = 'rejected'; report.reason = why; report.finished = new Date().toISOString(); fs.writeFileSync(path.join(OUT, 'last-build-failed.json'), JSON.stringify(report, null, 1)); fs.appendFileSync(path.join(OUT, 'build-log.ndjson'), JSON.stringify({ at: report.finished, status: 'rejected', reason: why.slice(0, 400) }) + '\n'); console.error('REJECTED:', why); console.error('The previous index (if any) is untouched.'); return 2; }
/* exit through process.exitCode (not process.exit): on Windows an abrupt exit with open sockets can crash Node with a native error code */
run().then(code => { process.exitCode = code; }, e => { const blocked = e && e.blocked; try { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'build-log.ndjson'), JSON.stringify({ at: new Date().toISOString(), status: blocked ? 'blocked' : 'error', reason: String(e && e.message).slice(0, 400) }) + '\n'); fs.writeFileSync(path.join(OUT, 'last-build-failed.json'), JSON.stringify({ status: blocked ? 'blocked' : 'error', reason: String(e && e.message), at: new Date().toISOString() }, null, 1)); } catch (x) {} console.error((blocked ? 'BLOCKED: ' : 'ERROR: ') + (e && e.message)); console.error('The previous index (if any) is untouched.'); process.exitCode = 3; });
