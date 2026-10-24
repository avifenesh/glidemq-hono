import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of fs.readdirSync(path.join(root, '.github/workflows'))) {
  if (!/\.ya?ml$/.test(file)) continue;
  const text = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    if (/npm install.*zod@3/.test(line) && /--no-save|--package-lock=false/.test(line)) {
      throw new Error(`${file}: legacy Zod fixtures must update their manifest and lockfile; npm 10 can crash when replacing incompatible peers without the lock graph`);
    }
  }
}
console.log('CI peer-fixture policy passed');
