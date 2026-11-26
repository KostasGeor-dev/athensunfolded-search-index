'use strict';
// Minimal, dependency-free HTML scanner for the article pages of athensunfolded.com.
// extractArticle(html) -> { title, description, canonical, robots, ogType, hasProse, sections:[{h, text}] }
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', middot: '·', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', iacute: 'í', uacute: 'ú', ouml: 'ö', uuml: 'ü', ccedil: 'ç', copy: '©', times: '×', rarr: '→', larr: '←' };
function decode(s) { return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return ' '; } } return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m; }); }
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'aside', 'form', 'button', 'iframe', 'select', 'textarea']);
const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'blockquote', 'figure', 'figcaption', 'tr', 'table', 'br', 'dd', 'dt', 'header', 'footer', 'details', 'summary']);
function attr(tag, name) { const m = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag); return m ? decode(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]) : null; }
function meta(html, key, val) { const re = new RegExp('<meta\\b[^>]*\\b' + key + '\\s*=\\s*["\']' + val + '["\'][^>]*>', 'i'); const m = re.exec(html); return m ? attr(m[0], 'content') : null; }
function extractArticle(html) {
  const out = { title: null, description: null, canonical: null, robots: null, ogType: null, hasProse: false, sections: [] };
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); out.title = tm ? decode(tm[1]).trim() : null;
  out.description = meta(html, 'name', 'description'); out.robots = meta(html, 'name', 'robots'); out.ogType = meta(html, 'property', 'og:type');
  const cm = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.exec(html); out.canonical = cm ? attr(cm[0], 'href') : null;
  // JSON-LD headline / BlogPosting (stable title source)
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => { try { return JSON.parse(m[1]); } catch (e) { return null; } }).filter(Boolean); out.jsonld = ld;
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g; let m; const stack = []; let inProse = -1; let skipDepth = -1; let cur = { h: '', text: '' }; const secs = [cur]; let inHeading = -1; let hbuf = '';
  const proseStart = html.search(/class\s*=\s*["'][^"']*\bjn-prose\b/);
  if (proseStart < 0) return out; out.hasProse = true; re.lastIndex = html.lastIndexOf('<', proseStart);
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) { if (inProse >= 0 && skipDepth < 0) { const t = decode(m[3]); if (inHeading >= 0) hbuf += t; else cur.text += t; } continue; }
    if (m[0].startsWith('<!--')) continue; const closing = m[0][1] === '/'; const tag = m[1].toLowerCase(); const raw = m[0];
    if (!closing) {
      const selfClose = VOID.has(tag) || /\/>$/.test(raw);
      if (inProse < 0) { if (/class\s*=\s*["'][^"']*\bjn-prose\b/.test(raw)) { inProse = stack.length; stack.push({ tag, skip: false, prose: true }); } else if (!selfClose) stack.push({ tag }); continue; }
      if (skipDepth >= 0) { if (!selfClose) stack.push({ tag, skip: true }); continue; }
      const cls = attr(raw, 'class') || ''; const hidden = /\baria-hidden\s*=\s*["']true["']/.test(raw) || /\bhidden\b/.test(raw.replace(/class\s*=\s*"[^"]*"/, ''));
      if (!selfClose && (SKIP_TAGS.has(tag) || /\b(jn-ctx|jn-cta|cookiebot|CybotCookiebot)/i.test(cls) || /\bjn-(ctx|cta|share|related|next|prev)\b/.test(cls))) { skipDepth = stack.length; stack.push({ tag, skip: true }); continue; }
      if (BLOCK.has(tag)) { if (inHeading < 0) cur.text += ' \n '; }
      if (/^h[1-4]$/.test(tag)) { inHeading = stack.length; hbuf = ''; }
      if (!selfClose) stack.push({ tag });
    } else {
      // closing tag: pop to the matching opener
      let i = stack.length - 1; while (i >= 0 && stack[i].tag !== tag) i--; if (i < 0) continue; const was = stack.splice(i);
      if (skipDepth >= 0 && i <= skipDepth) skipDepth = -1;
      if (inHeading >= 0 && i <= inHeading) { const h = decode(hbuf).replace(/\s+/g, ' ').trim(); inHeading = -1; if (h) { cur = { h, text: '' }; secs.push(cur); } }
      if (inProse >= 0 && i <= inProse) break;
      if (BLOCK.has(tag) && inProse >= 0 && skipDepth < 0) cur.text += ' \n ';
    }
  }
  out.sections = secs.map(s => ({ h: s.h, text: s.text.replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/ ?\n ?(\n ?)*/g, '\n').trim() })).filter((s, i) => i === 0 || s.h);
  return out;
}
module.exports = { extractArticle, decode };
