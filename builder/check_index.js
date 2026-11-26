#!/usr/bin/env node
'use strict';
// Reproducible completeness / freshness check:  published inventory (public sources)  vs  the deployed index.
//   node builder/check_index.js --base https://www.athensunfolded.com --index <folder | manifest URL | page URL> [--max-age-hours 36] [--pace 1500]
// Exit: 0 OK (counts equal, ids equal, fresh) | 1 STALE by age only | 2 MISMATCH (published articles missing from the index, or unpublished ones still in it) | 3 cannot check (network/WAF/unreadable index)
const fs = require('fs'), path = require('path'); const { Client } = require('./lib/http'); const { discover } = require('./lib/discover');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const BASE = arg('base', 'https://www.athensunfolded.com'), SRC = arg('index', 'dist'), MAXH = +arg('max-age-hours', 36), PACE = +arg('pace', 1500);
async function loadIndex(src) {
  if (!/^https?:/.test(src) && !src.startsWith('/')) { const dir = path.resolve(src); const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); return { man, index: JSON.parse(fs.readFileSync(path.join(dir, man.file), 'utf8')) }; }
  const url = src.startsWith('/') ? BASE + src : src; const r = await fetch(url, { headers: { 'User-Agent': 'AthensUnfoldedIndexCheck/2.0' } }); if (!r.ok) throw new Error('index source HTTP ' + r.status); const t = await r.text();
  if (/\.json(\?.*)?$/.test(url)) { const man = JSON.parse(t); const r2 = await fetch(url.replace(/[^/]*$/, '') + man.file); if (!r2.ok) throw new Error('index file HTTP ' + r2.status); return { man, index: await r2.json() }; }
  const a = t.indexOf('id="au-search-index"'); if (a < 0) throw new Error('no index data in the page'); const s = t.slice(t.indexOf('>', a) + 1, t.indexOf('<' + '/script>', a)); const o = JSON.parse(s); return { man: o.manifest, index: o.index };
}
(async () => {
  let res = { checkedAt: new Date().toISOString(), status: 'ERROR' };
  try {
    const { man, index } = await loadIndex(SRC); const c = new Client({ base: BASE, pace: PACE }); const { articles, report } = await discover(c);
    const inv = new Map(articles.map(a => [a.id, a])), idx = new Map(index.docs.map(d => [d.id, d])); const missing = [...inv.values()].filter(a => !idx.has(a.id)).map(a => a.path), extra = [...idx.values()].filter(d => !inv.has(d.id)).map(d => d.p);
    const ageH = (Date.now() - Date.parse(man.verifiedAt || man.generation)) / 3600000; const moved = [...inv.values()].filter(a => idx.has(a.id) && idx.get(a.id).p !== a.path).map(a => idx.get(a.id).p + ' -> ' + a.path);
    res = { checkedAt: res.checkedAt, status: 'OK', inventory: inv.size, indexed: idx.size, missingFromIndex: missing, unpublishedStillInIndex: extra, moved, indexGeneration: man.generation, ageHours: +ageH.toFixed(1), maxAgeHours: MAXH, discoveryWarnings: report.warnings, discoveryErrors: report.errors };
    if (missing.length || extra.length || moved.length || report.errors.length) res.status = 'MISMATCH'; else if (ageH > MAXH) res.status = 'STALE';
  } catch (e) { res.error = String(e && e.message); res.status = e && e.blocked ? 'BLOCKED' : 'ERROR'; }
  console.log(JSON.stringify(res, null, 1)); process.exitCode = res.status === 'OK' ? 0 : res.status === 'STALE' ? 1 : res.status === 'MISMATCH' ? 2 : 3;
})();
