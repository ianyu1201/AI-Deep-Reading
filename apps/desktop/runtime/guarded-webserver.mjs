import { timingSafeEqual } from 'node:crypto';
import WebServer from '@deepseek-ai/dsh-host-webserver';

// A narrow D1 carrier adapter. Existing plugin routes still register unchanged,
// but only the readiness library read can cross this transport.
export default class GuardedReadingWebServer extends WebServer {
  guard(handler) {
    return (req, res) => {
      const token = process.env.AI_READING_INTERNAL_TOKEN;
      const expected = Buffer.from(`Bearer ${token ?? ''}`);
      const actual = Buffer.from(String(req.headers.authorization ?? ''));
      const reject = status => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Route unavailable' })); };
      if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reject(401);
      if (req.headers.origin) return reject(403);
      const url = new URL(req.url, 'http://127.0.0.1');
      const read = req.method === 'GET' && ['/apple-read/api/reading/library', '/reading-internal/events'].includes(url.pathname);
      const business = req.method === 'POST' && url.pathname === '/reading-business';
      const call = req.method === 'POST' && /^\/reading-internal\/sessions\/(list|create|ensure|resume|history|prompt|cancel|rename|archive|restore|trash)$/.test(url.pathname);
      if ((!read && !call && !business) || url.search) return reject(403);
      return handler(req, res);
    };
  }
  register(route) { return super.register({ ...route, handler: this.guard(route.handler) }); }
  registerFallback(handler) { return super.registerFallback(this.guard(handler)); }
  registerUpgrade() { throw new Error('WebSocket routes are disabled in the D1 runtime'); }
}
