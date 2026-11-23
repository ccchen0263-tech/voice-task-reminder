// 在多個時區各跑一次全部測試（Windows、macOS、Linux 都能用，不需要 TZ= 前綴）。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const zones = ['Asia/Taipei', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.js'))
  .map(name => `tests/${name}`);
let failed = false;
for (const zone of zones) {
  const run = spawnSync(process.execPath, ['--test', ...files], {
    env: { ...process.env, TZ: zone }, encoding: 'utf8',
  });
  const summary = (run.stdout.match(/^# (pass|fail) \d+$/gm) || []).join(', ');
  console.log(`${zone}: ${summary || '(no summary)'}`);
  if (run.status !== 0) { failed = true; process.stdout.write(run.stdout.split('\n').filter(line => /^not ok|^\s+(error|expected|actual):/.test(line)).join('\n') + '\n'); }
}
process.exitCode = failed ? 1 : 0;
