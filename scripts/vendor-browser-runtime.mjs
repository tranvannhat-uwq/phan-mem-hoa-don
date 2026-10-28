import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Pin the exact UMD releases previously served by the application's CDN URLs.
const packages = [
  { name: 'supabase', version: '2.118.0', script: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js', license: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/LICENSE' },
  { name: 'xlsx', version: '1.2.0', script: 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js', license: 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/LICENSE' },
  { name: 'chart', version: '4.6.1', script: 'https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.js', license: 'https://cdn.jsdelivr.net/npm/chart.js@4.6.1/LICENSE.md' },
  { name: 'lucide', version: '1.62.0', script: 'https://unpkg.com/lucide@1.62.0/dist/umd/lucide.min.js', license: 'https://unpkg.com/lucide@1.62.0/LICENSE' }
];
const output = new URL('../js/vendor/', import.meta.url);
await mkdir(output, { recursive: true });
const manifest = await Promise.all(packages.map(async entry => {
  const [scriptResponse, licenseResponse] = await Promise.all([
    fetch(entry.script, { signal: AbortSignal.timeout(20000) }),
    fetch(entry.license, { signal: AbortSignal.timeout(20000) })
  ]);
  if (!scriptResponse.ok || !licenseResponse.ok) throw new Error(`Could not download ${entry.name}: script ${scriptResponse.status}, license ${licenseResponse.status}`);
  const script = new Uint8Array(await scriptResponse.arrayBuffer());
  const license = await licenseResponse.text();
  await writeFile(new URL(`${entry.name}.js`, output), script);
  await writeFile(new URL(`${entry.name}.LICENSE.txt`, output), license);
  return { ...entry, bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') };
}));
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.map(({ name, version, bytes }) => ({ name, version, bytes }))));
