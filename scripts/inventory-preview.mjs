// Isolated local UI harness. Serves only frontend source and its synthetic test.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const path = resolve(root, `.${pathname}`);
  const name = relative(root,path).split(sep).join('/');
  const allowed = name === 'tests/inventory-ui-harness.html' || name === 'style.css' || /^js\/[\w./-]+\.js$/.test(name);
  if(!allowed || !['GET','HEAD'].includes(request.method)) {response.writeHead(404).end();return;}
  try {const body=await readFile(path);response.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'}).end(request.method==='HEAD'?undefined:body);}
  catch{response.writeHead(404).end();}
}).listen(5176,'127.0.0.1',()=>console.log('Inventory synthetic UI: http://127.0.0.1:5176/tests/inventory-ui-harness.html'));
