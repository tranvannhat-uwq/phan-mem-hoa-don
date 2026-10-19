// Isolated synthetic invoice picker preview. Never serves backups or business data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const path = resolve(root, `.${pathname}`);
  const name = relative(root, path).split(sep).join('/');
  const allowed = name === 'tests/invoice-product-search-harness.html' || name === 'style.css' || /^js\/[\w./-]+\.js$/.test(name);
  if (!allowed || !['GET','HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(path);
    response.writeHead(200, {'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'}).end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404).end(); }
}).listen(5182,'127.0.0.1',() => console.log('Synthetic Sale invoice: http://127.0.0.1:5182/tests/invoice-product-search-harness.html'));
