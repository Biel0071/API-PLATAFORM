import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.join(root, 'apps/dashboard/public');
const files = ['app.js', 'app.css'];
const sources = await Promise.all(files.map(file => readFile(path.join(dashboard, file))));
const version = createHash('sha256').update(Buffer.concat(sources)).digest('hex').slice(0, 16);
const html = await readFile(path.join(dashboard, 'index.html'), 'utf8');
await writeFile(path.join(dashboard, 'index.html'), html.replace(/(app\.(?:js|css)\?v=)[^"']+/g, `$1${version}`));
await writeFile(path.join(dashboard, 'platform-build.json'), JSON.stringify({ version, source: 'apps/dashboard/public', mode: 'standalone' }, null, 2) + '\n');
console.log(`Dashboard canônico: ${version}`);
