const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 5175;

const server = http.createServer((req, res) => {
  const reqPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(root, reqPath === '/' ? '/index.html' : reqPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html'
      : ext === '.css' ? 'text/css'
      : ext === '.js' ? 'text/javascript'
      : ext === '.json' ? 'application/json'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.listen(port, () => console.log(`Dexory Raw Stock demo server on http://localhost:${port}`));
