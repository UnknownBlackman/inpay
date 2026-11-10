// Runs the near-workspaces sandbox tests. near-sandbox ships Linux and macOS binaries
// only, so on Windows the tests run inside a node:20 Docker container.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts }).status ?? 1;

if (process.platform !== 'win32') {
  process.exit(run('npx', ['tsx', '--test', '--test-concurrency=1', 'tests/contract.sandbox.test.ts']));
}

const docker = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 });
if (docker.status !== 0) {
  console.error('\nContract sandbox tests need Linux/macOS, or Docker on Windows (near-sandbox has no Windows binary).');
  console.error('Start Docker Desktop and re-run `npm test`, or run `npm run test:contract` in WSL / Linux.\n');
  process.exit(1);
}
const vol = root.replace(/\\/g, '/');
process.exit(run('docker', [
  'run', '--rm', '-v', `${vol}:/app`, '-v', 'inpay_node_modules:/app/node_modules', '-w', '/app', 'node:20',
  'sh', '-c', '"npm ci --no-audit --no-fund --foreground-scripts >/dev/null && npx tsx --test --test-concurrency=1 tests/contract.sandbox.test.ts"',
]));
