// Minimal static server. getUserMedia needs a secure context, which means
// http://localhost (fine) or HTTPS (needed to open the app on a phone). Pass
// --https and it will generate a self-signed certificate with openssl.
import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = new URL('.', import.meta.url).pathname;
const PORT = +(process.env.PORT ?? 8080);
const useHttps = process.argv.includes('--https');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
};

async function cert() {
  const dir = join(ROOT, '.cert');
  const key = join(dir, 'key.pem'), crt = join(dir, 'cert.pem');
  try {
    await access(key); await access(crt);
  } catch {
    await mkdir(dir, { recursive: true });
    await promisify(execFile)('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', crt, '-subj', '/CN=umpire.local',
    ]);
    console.log('generated a self-signed certificate in .cert/');
  }
  return { key: await readFile(key), cert: await readFile(crt) };
}

const lan = Object.values(networkInterfaces()).flat()
  .find(i => i && i.family === 'IPv4' && !i.internal)?.address;

if (useHttps) {
  https.createServer(await cert(), handler).listen(PORT, () => {
    console.log(`umpire  https://localhost:${PORT}`);
    if (lan) console.log(`on your phone: https://${lan}:${PORT}  (accept the self-signed warning)`);
  });
} else {
  http.createServer(handler).listen(PORT, () => {
    console.log(`umpire  http://localhost:${PORT}`);
    console.log('for a phone or another machine, run: npm run start:https');
  });
}
