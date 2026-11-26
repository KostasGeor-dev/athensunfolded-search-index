'use strict';
// Polite, paced HTTP client. Never bypasses restrictions: HTTP 403/429 (CloudFront/WAF) aborts the whole build (the last good index stays live).
class BlockedError extends Error { constructor(url, status) { super('Blocked by the server (HTTP ' + status + ') at ' + url + ': stopping, nothing is overwritten'); this.blocked = true; this.status = status; } }
class Client {
  constructor(opts) { this.base = String(opts.base).replace(/\/$/, ''); this.pace = opts.pace == null ? 1500 : opts.pace; this.timeout = opts.timeout || 20000; this.retries = opts.retries == null ? 2 : opts.retries; this.ua = opts.ua || 'Mozilla/5.0 (compatible; AthensUnfoldedSearchIndexer/2.0; +https://www.athensunfolded.com)'; this.requests = 0; this.bytes = 0; this.last = 0; this.log = opts.log || (() => {}); }
  async sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async get(path, accept) {
    const url = path.startsWith('http') ? path : this.base + path; let lastErr;
    for (let a = 0; a <= this.retries; a++) {
      const wait = this.pace - (Date.now() - this.last); if (wait > 0) await this.sleep(wait); this.last = Date.now();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeout);
      try { const r = await fetch(url, { headers: { 'User-Agent': this.ua, 'Accept': accept || '*/*', 'Accept-Encoding': 'gzip' }, signal: ctrl.signal, redirect: 'follow' }); const body = await r.text(); clearTimeout(t); this.requests++; this.bytes += Buffer.byteLength(body);
        if (r.status === 403 || r.status === 429) throw new BlockedError(url, r.status);
        if (r.status >= 500) { lastErr = new Error('HTTP ' + r.status + ' ' + url); await this.sleep(1500 * (a + 1)); continue; }
        return { status: r.status, body, headers: r.headers, url }; }
      catch (e) { clearTimeout(t); if (e.blocked) throw e; lastErr = e; if (a < this.retries) await this.sleep(1500 * (a + 1)); }
    }
    throw lastErr || new Error('request failed ' + url);
  }
}
module.exports = { Client, BlockedError };
