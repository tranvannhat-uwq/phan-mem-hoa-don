import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';
const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : (process.env.PORT || 5173));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Cổng không hợp lệ. Ví dụ: npm run dev -- --port 5174');
  process.exit(1);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const filePath = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const publicPath = relative(root, filePath).split(sep).join('/');
  // Serve frontend assets only; database backups and local scripts stay private.
  const isPublicAsset = publicPath === 'index.html' || publicPath === 'style.css'
    || /^js\/(?!.*(?:^|\/)\.)[\w./-]+\.js$/.test(publicPath)
    || /^[\w-]+\.(?:png|jpe?g|webp|svg|ico)$/.test(publicPath);
  if (!isPublicAsset || pathname.includes('\0')) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)],
      'Content-Length': content.length
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500)
      .end('Không thể tải tệp.');
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Cổng ${port} đang được sử dụng. Chạy: npm run dev -- --port ${port + 1}`
    : `Không thể khởi động máy chủ: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Ứng dụng: http://${host}:${port}/#/ban-hang`);
  console.log('Dừng máy chủ: Ctrl+C. Sau khi sửa mã, tải lại trang để xem thay đổi.');
});
