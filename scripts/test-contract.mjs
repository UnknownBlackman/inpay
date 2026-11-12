// Runs the near-workspaces sandbox tests. near-sandbox ships Linux and macOS binaries
// only, so on Windows the tests run inside a node:20 Docker container.
//
// Sandbox version: near-workspaces 5.0 installs the nearcore 2.6.2 sandbox, which predates
// NEAR's global contracts. Contracts built with near-sdk 5.x import the host function
// `promise_batch_action_deploy_global_contract` (testnet has it), so on 2.6.2 every deploy fails
// with "unknown import". We pin a sandbox from nearcore 2.7.1, the first line with global
// contracts: if the installed binary is another version it is removed, and near-workspaces
// downloads this one (SANDBOX_ARTIFACT_URL) the first time a test starts a sandbox.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_VERSION = '2.7.1';
const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts }).status ?? 1;

/** nearcore sandbox build URL for this machine (the same platform names near-sandbox uses). */
function sandboxUrl(platform = os.type(), arch = os.arch()) {
  const a = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : arch;
  return `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platform}-${a}/${SANDBOX_VERSION}/near-sandbox.tar.gz`;
}

/** Make sure the next sandbox start uses nearcore SANDBOX_VERSION. */
function pinSandbox() {
  const bin = path.join(root, 'node_modules', 'near-sandbox', 'bin');
  const marker = path.join(bin, '.inpay-sandbox-version');
  const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
  if (current !== SANDBOX_VERSION) {
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(marker, SANDBOX_VERSION);
    console.log(`Using the nearcore ${SANDBOX_VERSION} sandbox (downloaded on first use).`);
  }
  return { ...process.env, SANDBOX_ARTIFACT_URL: sandboxUrl() };
}

if (process.platform !== 'win32') {
  const env = pinSandbox();
  process.exit(run('npx', ['tsx', '--test', '--test-concurrency=1', 'tests/contract.sandbox.test.ts'], { env }));
}

const docker = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 });
if (docker.status !== 0) {
  console.error('\nContract sandbox tests need Linux/macOS, or Docker on Windows (near-sandbox has no Windows binary).');
  console.error('Start Docker Desktop and re-run `npm test`, or run `npm run test:contract` in WSL / Linux.\n');
  process.exit(1);
}
const vol = root.replace(/\\/g, '/');
process.exit(run('docker', [
  'run', '--rm', '-v', `${vol}:/app`, '-v', 'inpay_node_modules:/app/node_modules', '-w', '/app',
  '-e', `SANDBOX_ARTIFACT_URL=${sandboxUrl('Linux', 'x64')}`, 'node:20',
  'sh', '-c', '"npm ci --no-audit --no-fund --foreground-scripts >/dev/null && npx tsx --test --test-concurrency=1 tests/contract.sandbox.test.ts"',
]));
