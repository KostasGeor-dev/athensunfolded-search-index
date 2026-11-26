/* Athens Unfolded — full-text search engine V2 (ES5, no dependencies; runs in the browser and in Node).
   build(articles, meta)  -> compact index object (what the pipeline publishes as JSON)
   load(index)            -> searchable engine
   engine.search(query, opts) -> ranked results { doc, score, fields, secs, mode }
   Index format v2: { v:2, meta, cats:[{slug,name}], docs:[{id,p,t,d,c:[catIdx],i,th,ts,h:[headings]}], terms:{ stem:[doc,mask,tf,secmask, doc,mask,tf,secmask, ...] } }
   mask bits: 1 title, 2 heading, 4 description, 8 category/slug, 16 article body. secmask bit0 = introduction, bit n = heading n (n>=15 shares bit 15). */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.AUSearch = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var UKUS = [[/neighbor/g, 'neighbour'], [/theater/g, 'theatre'], [/center/g, 'centre'], [/color/g, 'colour'], [/favorite/g, 'favourite'], [/traveler/g, 'traveller'], [/gray/g, 'grey'], [/organiz/g, 'organis'], [/(^| )labor/g, '$1labour'], [/honor/g, 'honour'], [/analyz/g, 'analys'], [/catalog\b/g, 'catalogue'], [/defense/g, 'defence'], [/license/g, 'licence'], [/meter\b/g, 'metre'], [/kilometer/g, 'kilometre'], [/realiz/g, 'realis'], [/recogniz/g, 'recognis'], [/itiner/g, 'itiner']];
  var STOP = {}; 'the and for with that this from are was were but not you your our their its has have had can will would should could into onto over under about after before than then them they what when where which while who whom why how all any each few more most other some such only own same too very just also out off per via etc one two get got did does done been being here there these those his her him she its it is in on at as of to by an a or if so no be do we us up'.split(' ').forEach(function (w) { STOP[w] = 1; });
  var SYN = { metro: ['subway', 'underground', 'train', 'transport', 'station'], station: ['metro'], subway: ['metro'], food: ['taverna', 'restaurant', 'meze', 'dining', 'eat', 'cuisine', 'menu', 'dish'], eat: ['food', 'taverna', 'dining'], restaurant: ['taverna', 'food'], taverna: ['food', 'restaurant'], walk: ['walking', 'route', 'stroll', 'walks'], walking: ['walk', 'route', 'stroll'], route: ['walk', 'walking'], history: ['ancient', 'historical', 'classical', 'archaeology'], ancient: ['history', 'classical'], acropolis: ['parthenon', 'propylaia', 'erechtheion'], parthenon: ['acropolis'], airport: ['transfer', 'arrival', 'arrive', 'flight'], transfer: ['airport', 'taxi'], arrival: ['airport', 'arrive'], cab: ['taxi'], uber: ['taxi'], bus: ['transport', 'airport'], tram: ['transport'], market: ['markets', 'shopping'], coffee: ['cafe'], cafe: ['coffee'], dinner: ['food', 'taverna', 'meal'], lunch: ['food', 'meal'], meal: ['food', 'dinner', 'lunch'], museum: ['museums', 'gallery'], church: ['churches', 'byzantine'], street: ['streets', 'road'], hill: ['hills'], heat: ['summer', 'weather', 'hot'], summer: ['heat', 'weather'], price: ['prices', 'cost', 'cheap'], neighbourhood: ['district', 'area', 'quarter'], area: ['neighbourhood', 'district'], taxi: ['transport', 'cab'], ticket: ['entry', 'admission'], hotel: ['stay', 'accommodation', 'lodging'], stay: ['hotel', 'accommodation'], first: ['beginner', 'newcomer'], visitor: ['tourist', 'traveller'], tourist: ['visitor'] };
  var BIT = { title: 1, heading: 2, desc: 4, cat: 8, body: 16 };
  var W = { title: 6, heading: 4, cat: 3, desc: 2.5, body: 1 };

  function norm(s) { s = String(s == null ? '' : s).toLowerCase(); try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {} s = s.replace(/[^a-z0-9Ͱ-Ͽ]+/g, ' ').trim(); for (var i = 0; i < UKUS.length; i++) s = s.replace(UKUS[i][0], UKUS[i][1]); return s; }
  /* light, symmetric stemming (index and query use the same function): plural forms only */
  function stem(w) { if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y'; if (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1); return w; }
  function words(s) { return norm(s).split(' ').filter(function (w) { return w.length > 1; }); }
  function termsOf(s) { var out = []; words(s).forEach(function (w) { if (STOP[w] || /^[0-9]+$/.test(w)) return; var t = stem(w); if (t.length >= 3) out.push(t); }); return out; }
  function near(a, b) { if (Math.abs(a.length - b.length) > 1) return false; var i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; if (i === a.length && i === b.length) return true; if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)); return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i); }

  /* ---------- BUILD (pipeline side) ---------- */
  function build(articles, meta) {
    var cats = [], catIx = {}; var docs = [], terms = {};
    var sorted = articles.slice().sort(function (a, b) { return (b.ts - a.ts) || (b.id - a.id); });
    sorted.forEach(function (a, di) {
      var c = (a.cats || []).map(function (x) { if (!(x.slug in catIx)) { catIx[x.slug] = cats.length; cats.push({ slug: x.slug, name: x.name }); } return catIx[x.slug]; });
      var heads = (a.sections || []).slice(1).map(function (s) { return s.h; });
      docs.push({ id: a.id, p: a.path, t: a.title, d: a.desc || '', c: c, i: a.img || '', th: a.thumb || '', ts: a.ts || 0, h: heads });
      var seen = {};
      function add(term, bit, sec) { var r = seen[term]; if (!r) { r = seen[term] = { m: 0, tf: 0, s: 0 }; } r.m |= bit; if (bit === 16) { r.tf++; r.s |= sec; } else if (bit === 2 && sec != null) r.s |= sec; }
      termsOf(a.title).forEach(function (t) { add(t, 1); });
      (a.desc ? termsOf(a.desc) : []).forEach(function (t) { add(t, 4); });
      (a.cats || []).forEach(function (x) { termsOf(x.name).forEach(function (t) { add(t, 8); }); });
      termsOf(String(a.path || '').replace(/[\/-]+/g, ' ')).forEach(function (t) { add(t, 8); });
      (a.sections || []).forEach(function (s, si) { var bit = si > 15 ? 15 : si; if (si > 0) termsOf(s.h).forEach(function (t) { add(t, 2, 1 << bit); }); termsOf(s.text).forEach(function (t) { add(t, 16, 1 << bit); }); });
      Object.keys(seen).forEach(function (t) { var r = seen[t]; (terms[t] = terms[t] || []).push(di, r.m, Math.min(r.tf, 15), r.s & 0xffff); });
    });
    var ordered = {}; Object.keys(terms).sort().forEach(function (k) { ordered[k] = terms[k]; });
    return { v: 2, meta: meta || {}, cats: cats, docs: docs, terms: ordered };
  }

  /* ---------- LOAD + SEARCH (runtime side) ---------- */
  function load(index) {
    if (!index || index.v !== 2 || !index.docs || !index.terms) throw new Error('bad index');
    var keys = Object.keys(index.terms).sort(); var N = index.docs.length; var tcache = {};
    function lowerBound(x) { var lo = 0, hi = keys.length; while (lo < hi) { var m = (lo + hi) >> 1; if (keys[m] < x) lo = m + 1; else hi = m; } return lo; }
    function prefixTerms(p, cap) { var out = [], i = lowerBound(p); while (i < keys.length && keys[i].indexOf(p) === 0 && out.length < cap) out.push(keys[i++]); return out; }
    function fuzzyTerms(t) { var out = []; if (t.length < 5) return out; for (var i = 0; i < keys.length && out.length < 12; i++) { var k = keys[i]; if (Math.abs(k.length - t.length) <= 1 && near(k, t)) out.push(k); } return out; }
    function expand(tok) {
      if (tcache[tok]) return tcache[tok]; var res = {}; /* term -> weight */
      var st = stem(tok); var ex = index.terms[st] ? [st] : []; ex.forEach(function (k) { res[k] = 1; });
      if (tok.length >= 3) prefixTerms(st, 300).forEach(function (k) { if (!(k in res)) res[k] = k === st ? 1 : 0.85; });
      if (!Object.keys(res).length) fuzzyTerms(st).forEach(function (k) { res[k] = 0.55; });
      var syn = SYN[tok] || SYN[st] || []; syn.forEach(function (s) { var ss = stem(norm(s)); if (index.terms[ss] && !(ss in res)) res[ss] = -0.4; }); /* negative = synonym (weak, no body-only matches) */
      return (tcache[tok] = res);
    }
    function search(query, opts) {
      opts = opts || {}; var qw = words(query); var toks = qw.filter(function (w) { return !STOP[w]; }); if (!toks.length) toks = qw; toks = toks.slice(0, 8);
      if (!toks.length) return { results: [], mode: 'and', tokens: [] };
      var catOk = null; if (opts.cat) { var ci = -1; index.cats.forEach(function (c, i) { if (c.slug === opts.cat) ci = i; }); catOk = ci; }
      var per = toks.map(function (tok) {
        var ex = expand(tok), map = {}; /* doc -> {s, fields, secs, syn} */
        Object.keys(ex).forEach(function (term) {
          var w = ex[term], syn = w < 0, ww = Math.abs(w), p = index.terms[term], df = p.length / 4, idf = Math.max(1, 1 + 0.5 * Math.log(N / df));
          for (var i = 0; i < p.length; i += 4) { var d = p[i], m = p[i + 1], tf = p[i + 2], sc = p[i + 3]; if (syn) { if (!(m & 15)) continue; m &= 15; }
            var base = 0, f = 0; if (m & 1) { base = W.title; f = 1; } else if (m & 2) { base = W.heading; f = 2; } else if (m & 8) { base = W.cat; f = 8; } else if (m & 4) { base = W.desc; f = 4; } else { base = W.body; f = 16; }
            var s = (base + (m & 16 ? 0.35 * Math.log(1 + tf) : 0) + (base > 1 && (m & 2) && !(m & 1) ? 0 : 0)) * ww * idf; var e = map[d]; if (!e) e = map[d] = { s: 0, fields: 0, secs: 0, syn: true };
            if (s > e.s) e.s = s; e.fields |= m; if (m & 18) e.secs |= sc; if (!syn) e.syn = false; }
        }); return map; });
      var mode = 'and', ids = Object.keys(per[0]); ids = ids.filter(function (d) { return per.every(function (m) { return m[d]; }); });
      if (!ids.length && per.length > 1) { mode = 'some'; var u = {}; per.forEach(function (m) { Object.keys(m).forEach(function (d) { u[d] = 1; }); }); ids = Object.keys(u); }
      var out = ids.map(function (d) { var s = 0, fields = 0, secs = 0, hit = 0, syn = true; per.forEach(function (m) { var e = m[d]; if (e) { s += e.s; fields |= e.fields; secs |= e.secs; hit++; if (!e.syn) syn = false; } }); var doc = index.docs[d]; if (hit === per.length && per.length > 1) { var tl = norm(doc.t); if (toks.every(function (t) { return tl.indexOf(t) !== -1; })) s *= 1.25; } if (mode === 'some') s *= hit / per.length; return { i: +d, doc: doc, score: s, fields: fields, secs: secs, hits: hit, synOnly: syn }; });
      if (catOk !== null) out = out.filter(function (r) { return catOk >= 0 && r.doc.c.indexOf(catOk) !== -1; });
      out.sort(function (a, b) { return (b.score - a.score) || (b.doc.ts - a.doc.ts) || (b.doc.id - a.doc.id); });
      return { results: out, mode: mode, tokens: toks };
    }
    /* where did it match? -> short, accurate location label (never a quoted fragment out of context) */
    function where(r, tokens) { var f = r.fields; if (f & 1) return ''; var secs = r.secs, doc = r.doc; if (r.synOnly) return 'Related topic'; if (f & 2 || f & 16) {
        var sts = (tokens || []).map(function (t) { return stem(t); }), first = 0;
        for (var n = 1; n < 16; n++) { if (!(secs & (1 << n)) || !doc.h[n - 1]) continue; if (!first) first = n; var ht = termsOf(doc.h[n - 1]); if (sts.length && ht.some(function (h) { return sts.some(function (s) { return h.indexOf(s) === 0; }); })) return 'In the section “' + doc.h[n - 1] + '”'; }
        if (first) return 'In the section “' + doc.h[first - 1] + '”'; if (secs & 1) return 'Mentioned in the introduction'; return 'Mentioned in the article text'; } return ''; }
    return { search: search, where: where, size: N, meta: index.meta || {}, cats: index.cats, docs: index.docs, termCount: keys.length };
  }
  return { norm: norm, stem: stem, termsOf: termsOf, build: build, load: load, BIT: BIT, STOP: STOP };
});
