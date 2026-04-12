const { createServer: createHttpsServer } = require('https');
const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const httpProxy = require('http-proxy');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '8888', 10);
const sslKey = process.env.SSL_KEY;
const sslCert = process.env.SSL_CERT;
const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://localhost:8000';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({
  target: backendUrl,
  ws: true,
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Backend unavailable');
  }
});

const caPath = process.env.SSL_CERT
  ? require('path').join(require('path').dirname(process.env.SSL_CERT), 'ca.pem')
  : null;

function isBackendPath(pathname) {
  if (pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/ws/') || pathname === '/ws') return true;
  return false;
}

app.prepare().then(() => {
  const handler = (req, res) => {
    const parsedUrl = parse(req.url, true);
    // Serve CA certificate for client installation
    if (parsedUrl.pathname === '/ca.pem' && caPath && fs.existsSync(caPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="matchmaker-ca.pem"',
      });
      fs.createReadStream(caPath).pipe(res);
      return;
    }
    if (isBackendPath(parsedUrl.pathname)) {
      if (parsedUrl.pathname.startsWith('/api/')) {
        req.url = req.url.replace(/^\/api/, '');
      }
      proxy.web(req, res);
    } else {
      handle(req, res, parsedUrl);
    }
  };

  let server;
  if (sslKey && sslCert) {
    server = createHttpsServer(
      { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) },
      handler
    );
  } else {
    server = createHttpServer(handler);
  }

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    if (isBackendPath(parsedUrl.pathname)) {
      proxy.ws(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    const proto = sslKey ? 'https' : 'http';
    console.log(`> Ready on ${proto}://${hostname}:${port}`);
    console.log(`> Proxying backend paths to ${backendUrl}`);
  });
});
