import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function release(mode, metadata, fetchRegistry = fetch, run = execFileSync) {
  if (!['publish', 'verify'].includes(mode)) throw new Error('Expected publish or verify');
  const packed = JSON.parse(run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))[0];
  if (packed.name !== metadata.name || packed.version !== metadata.version || !packed.shasum) {
    throw new Error('Packed metadata does not match the release');
  }
  const response = await fetchRegistry(
    `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`,
    { signal: AbortSignal.timeout(10000), headers: { 'cache-control': 'no-cache' } },
  );
  if (response.status === 404) {
    if (mode === 'verify') return 75;
    run('npm', ['publish', '--access', 'public', '--ignore-scripts', '--provenance'], { stdio: 'inherit' });
    return 0;
  }
  if (!response.ok) throw new Error(`Registry lookup failed with HTTP ${response.status}`);
  const published = await response.json();
  if (published.name !== metadata.name || published.version !== metadata.version || published.dist?.shasum !== packed.shasum) {
    throw new Error('Published release does not match the packed artifact');
  }
  console.log(`Verified ${metadata.name}@${metadata.version} (${packed.shasum})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await release(process.argv[2], JSON.parse(readFileSync('package.json', 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
