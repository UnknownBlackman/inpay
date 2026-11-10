// Rebuilds contract/res/inpay.wasm and contract/res/fungible_token.wasm (both are committed,
// so this is only needed after changing the contract). Uses the Rust 1.86 toolchain pinned
// in rust-toolchain.toml (newer rustc emits wasm features the NEAR VM may reject).
//
// fungible_token.wasm is the unmodified near-examples/FT source (commit below), built with
// its near-sdk dependency resolved to the newest 5.x that supports Rust 1.86.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sh = (cmd, cwd = root, env = {}) => execSync(cmd, { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
const FT_COMMIT = '15360ac443fe91e9d55a3b3db616fe6eb6514942';
const flags = { RUSTFLAGS: '-C link-arg=-s' };

sh('cargo build --target wasm32-unknown-unknown --release', path.join(root, 'contract'), flags);
cpSync(path.join(root, 'contract/target/wasm32-unknown-unknown/release/inpay.wasm'), path.join(root, 'contract/res/inpay.wasm'));

if (process.argv.includes('--ft')) {
  const ft = path.join(root, '.build/ft');
  if (!existsSync(ft)) sh(`git clone https://github.com/near-examples/FT "${ft}"`);
  sh(`git checkout -q ${FT_COMMIT}`, ft);
  rmSync(path.join(ft, 'rust-toolchain.toml'), { force: true });
  rmSync(path.join(ft, 'Cargo.lock'), { force: true });
  let toml = readFileSync(path.join(ft, 'Cargo.toml'), 'utf8');
  toml = toml.replace(/"5\.\d+\.\d+"/g, '"5"').replace(/^near-sandbox.*$/m, '');
  if (!toml.includes('rust-version')) toml = toml.replace('edition = "2018"', 'edition = "2018"\nrust-version = "1.86"\nresolver = "2"');
  writeFileSync(path.join(ft, 'Cargo.toml'), toml);
  sh('cargo +1.86.0 generate-lockfile', ft, { CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: 'fallback' });
  sh('cargo +1.86.0 build --target wasm32-unknown-unknown --release --lib', ft, flags);
  cpSync(path.join(ft, 'target/wasm32-unknown-unknown/release/fungible_token.wasm'), path.join(root, 'contract/res/fungible_token.wasm'));
}
console.log('wasm files are in contract/res/');
