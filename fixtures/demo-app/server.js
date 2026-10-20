import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createFixtureAppHandler(defaultFixDefects = false) {
  return function requestHandler(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const fixParam = parsedUrl.searchParams.get('fix') || parsedUrl.searchParams.get('FIX_DEFECTS');
    const headerFix = req.headers['x-fix-defects'];
    const envFix = process.env.FIX_DEFECTS === 'true';

    const isFixed =
      fixParam === 'true' ||
      fixParam === '1' ||
      headerFix === 'true' ||
      envFix ||
      defaultFixDefects;

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fixDefects: isFixed }));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = path.join(__dirname, 'index.html');
      let html = fs.readFileSync(htmlPath, 'utf8');

      // Inject fix parameter state into HTML if requested via environment or query
      if (isFixed) {
        html = html.replace(
          '<head>',
          `<head>\n  <script>window.__FIX_DEFECTS__ = true;</script>`
        );
      } else {
        html = html.replace(
          '<head>',
          `<head>\n  <script>window.__FIX_DEFECTS__ = false;</script>`
        );
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname === '/styles.css') {
      const cssPath = path.join(__dirname, 'styles.css');
      const css = fs.readFileSync(cssPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
      return;
    }

    if (pathname === '/app.js') {
      const jsPath = path.join(__dirname, 'app.js');
      const js = fs.readFileSync(jsPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  };
}

export function startFixtureServer(options = {}) {
  const { port = 0, fixDefects = false } = options;
  const handler = createFixtureAppHandler(fixDefects);
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        url,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
    server.on('error', reject);
  });
}

// Standalone execution support
if (process.argv[1] && process.argv[1] === __filename) {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3456;
  const envFix = process.env.FIX_DEFECTS === 'true';

  startFixtureServer({ port: envPort, fixDefects: envFix }).then(({ url }) => {
    console.log(`Agentic QA Demo Fixture running at ${url} (FIX_DEFECTS=${envFix})`);
  });
}
