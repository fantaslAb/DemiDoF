/**
 * Remote log for the glasses build. The glasses' console is not reachable from a PC, so
 * the page batches JSON lines and POSTs them to `/log` on the server it was loaded from
 * (serve.py appends them to logs/<date>.jsonl). Disabled with `?log=0`; silently gives
 * up after repeated failures so a static host (GitHub Pages) is unaffected.
 */
export class RemoteLog {
  constructor({ url = 'log', interval = 1500, enabled = true } = {}) {
    this.url = url;
    this.interval = interval;
    this.enabled = enabled;
    this.session = Math.random().toString(36).slice(2, 8);
    this.queue = [];
    this.failures = 0;
    this.t0 = performance.now();
    if (enabled) {
      this.timer = setInterval(() => this.flush(), interval);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(true); });
      window.addEventListener('pagehide', () => this.flush(true));
      window.addEventListener('error', (e) => this.log('error', { msg: e.message, src: e.filename, line: e.lineno }));
      window.addEventListener('unhandledrejection', (e) => this.log('error', { msg: String(e.reason && e.reason.message || e.reason) }));
    }
  }

  log(type, data = {}) {
    if (!this.enabled) return;
    this.queue.push({ s: this.session, t: +((performance.now() - this.t0) / 1000).toFixed(3), type, ...data });
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
  }

  flush(beacon = false) {
    if (!this.enabled || !this.queue.length || this.failures > 5) return;
    const body = this.queue.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.queue.length = 0;
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(this.url, new Blob([body], { type: 'text/plain' }));
      return;
    }
    fetch(this.url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true })
      .then((r) => { if (!r.ok) this.failures++; else this.failures = 0; })
      .catch(() => { this.failures++; });
  }
}
