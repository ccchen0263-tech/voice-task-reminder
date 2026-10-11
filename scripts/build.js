import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = resolve(projectRoot, 'dist');

// Only remove this project's generated output directory.
if (dirname(outputDirectory) !== projectRoot || basename(outputDirectory) !== 'dist') {
  throw new Error('Build output must be the dist directory inside this project.');
}

const javascriptFiles = (await readdir(join(projectRoot, 'js'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => join('js', entry.name));
const assets = ['index.html', 'styles.css', ...javascriptFiles];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, 'js'), { recursive: true });

for (const asset of assets) {
  await copyFile(join(projectRoot, asset), join(outputDirectory, asset));
}

console.log(`Built ${assets.length} static assets in dist.`);
