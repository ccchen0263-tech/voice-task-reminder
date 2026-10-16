import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = resolve(projectRoot, 'dist');

// Only remove this project's generated output directory.
if (dirname(outputDirectory) !== projectRoot || basename(outputDirectory) !== 'dist') {
  throw new Error('Build output must be the dist directory inside this project.');
}

// Only the active Google flow. Legacy source/data helpers stay in the repository,
// but are not shipped or executed by this candidate.
const javascriptFiles = ['google-app', 'google-calendar', 'time-parser', 'planner', 'speech-input']
  .map(name => join('js', `${name}.js`));
const assets = ['index.html', 'styles.css', ...javascriptFiles];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, 'js'), { recursive: true });

for (const asset of assets) {
  await copyFile(join(projectRoot, asset), join(outputDirectory, asset));
}

console.log(`Built ${assets.length} static assets in dist.`);
