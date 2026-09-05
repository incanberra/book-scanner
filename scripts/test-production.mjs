import { spawnSync } from 'node:child_process';
const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'incanberra/book-scanner' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status ?? 1);
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.production.config.ts'], { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
