const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 5175;

/*
  Tiny hand-rolled .env loader - no "dotenv" package, since this project has
  no npm install step at all and isn't about to start one just for this.
  Reads KEY=VALUE lines from .env (gitignored) if it exists; a real
  environment variable of the same name always wins, so `ANTHROPIC_API_KEY=x
  node server.js` on the command line still overrides it.
*/
function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}
loadDotEnv();

// Claude's own vision + PDF document support does the actual reading; this
// just describes the shape we want back, enforced via tool use (Claude's
// equivalent of "respond with exactly this JSON schema") rather than hoping
// a plain-text prompt produces parseable JSON.
const ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const EXTRACTION_TOOL = {
  name: 'record_coc_extraction',
  description: "Record the Certificate of Conformity's extracted details.",
  input_schema: {
    type: 'object',
    properties: {
      supplierName: { type: 'string' },
      cocNumber: { type: 'string' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            partNo: { type: 'string' },
            qty: { type: 'number' },
            batches: {
              type: 'array',
              items: {
                type: 'object',
                properties: { batchNo: { type: 'string' }, qty: { type: 'number' } },
                required: ['batchNo', 'qty']
              }
            }
          },
          required: ['partNo', 'qty']
        }
      }
    },
    required: ['supplierName', 'cocNumber', 'lines']
  }
};

const EXTRACTION_PROMPT = `You are reading a supplier's Certificate of Conformity (CoC) for raw material delivered to a machine shop. Extract:
- supplierName: the supplier company's full printed name.
- cocNumber: the CoC's own reference/certificate number as printed (not a PO number).
- lines: one entry per distinct part number on the certificate. For each line give partNo, the total qty in pieces, and - only if the certificate lists individual batch/lot numbers for that part - a batches list of {batchNo, qty} pairs that add up to the line's qty.

This shop's own part numbers are labelled "DEX" followed by digits (e.g. "DEX05120234") - usually printed under a heading like "Part No.", "Our Ref.", "Customer Part No." or similar, not the supplier's own item/material code. If both a DEX-prefixed number and a supplier's own part/material code appear on the same line, partNo is the DEX-prefixed one.

Ignore stamps, signatures and handwritten annotations unless they're the only place a batch number or quantity appears. If several pages were provided, treat them as one certificate and merge continued line items across the page break rather than listing them twice.

Call record_coc_extraction with what you found.`;

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function handleExtractCoc(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "No Anthropic API key configured on this server - add ANTHROPIC_API_KEY to a .env file next to server.js and restart it (see README.md)." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
    return;
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    sendJson(res, 400, { error: 'No files provided.' });
    return;
  }

  const fileBlocks = files.map((f) =>
    f.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: f.mimeType, data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.data } }
  );

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
        messages: [
          { role: 'user', content: [...fileBlocks, { type: 'text', text: EXTRACTION_PROMPT }] }
        ]
      })
    });
  } catch (err) {
    console.error('Anthropic request failed:', err);
    sendJson(res, 502, { error: "Couldn't reach Claude - check this machine's internet connection and try again." });
    return;
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    console.error('Anthropic API error:', anthropicRes.status, errText);
    const hint = anthropicRes.status === 401 ? ' (check ANTHROPIC_API_KEY is correct)' : '';
    sendJson(res, 502, { error: `Claude couldn't read that file${hint}.` });
    return;
  }

  const data = await anthropicRes.json();
  const toolUse = (data.content || []).find((c) => c.type === 'tool_use');
  if (!toolUse) {
    console.error('No tool_use block in Claude response:', data);
    sendJson(res, 502, { error: 'Got an unreadable response back - try again, or enter the details manually below.' });
    return;
  }

  sendJson(res, 200, toolUse.input);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/extract-coc') {
    handleExtractCoc(req, res).catch((err) => {
      console.error('Unhandled error in /api/extract-coc:', err);
      sendJson(res, 500, { error: 'Unexpected server error.' });
    });
    return;
  }

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
