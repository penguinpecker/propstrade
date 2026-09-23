#!/usr/bin/env bash
# Reproducible build of pkg-node/ and pkg-web/ from GMTrade's gmx-solana v0.10.0 release.
#
#   1. shallow-clone the v0.10.0 tag (checked against its commit) into a scratch dir outside the repo
#   2. apply patches/liquidation-price.patch (the liquidation-price fix from GMTrade's unreleased HEAD)
#   3. add crate/ as a member of GMTrade's workspace so every dependency comes from its own Cargo.lock
#   4. cargo build for wasm32, then wasm-bindgen-cli 0.2.100 for the nodejs and web targets
#
# Needs: git, patch, rustc 1.95.0 with the wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.100
# (cargo install wasm-bindgen-cli --version 0.2.100 --locked).
# GMSOL_BUILD_DIR reuses a scratch dir (and its cargo target cache) between runs.
set -euo pipefail

TAG=v0.10.0
TAG_COMMIT=7ce035b41a266cb5ddb0192e5d29deb0c7e67a72
RUSTC_VERSION=1.95.0
WASM_BINDGEN_VERSION=0.2.100

here="$(cd "$(dirname "$0")" && pwd)"
work="${GMSOL_BUILD_DIR:-$(mktemp -d)}"
src="$work/gmx-solana"
patch_file="$here/patches/liquidation-price.patch"

rustc --version | grep -q "rustc $RUSTC_VERSION " || { echo "need rustc $RUSTC_VERSION" >&2; exit 1; }
[ "$(wasm-bindgen --version)" = "wasm-bindgen $WASM_BINDGEN_VERSION" ] ||
  { echo "need wasm-bindgen-cli $WASM_BINDGEN_VERSION" >&2; exit 1; }

[ -d "$src" ] || git clone --quiet --depth 1 --branch "$TAG" https://github.com/gmsol-labs/gmx-solana "$src"
[ "$(git -C "$src" rev-parse HEAD)" = "$TAG_COMMIT" ] || { echo "unexpected commit for $TAG" >&2; exit 1; }
[ -f "$work/Cargo.lock.orig" ] || cp "$src/Cargo.lock" "$work/Cargo.lock.orig"

if ! patch -p1 -R -s -f --dry-run -d "$src" < "$patch_file" > /dev/null; then
  patch -p1 -s -d "$src" < "$patch_file"
fi
rm -rf "$src/crates/props-gmsol"
cp -R "$here/crate" "$src/crates/props-gmsol"

(cd "$src" && cargo build --quiet --release --target wasm32-unknown-unknown -p props-gmsol)

# The lock may only gain the props-gmsol entry; a removed or changed line means a dependency drifted.
if diff "$work/Cargo.lock.orig" "$src/Cargo.lock" | grep -q '^<'; then
  echo "Cargo.lock changed existing entries" >&2
  exit 1
fi

wasm="$src/target/wasm32-unknown-unknown/release/props_gmsol.wasm"
rm -rf "$here/pkg-node" "$here/pkg-web"
wasm-bindgen --target nodejs --out-dir "$here/pkg-node" "$wasm"
echo '{ "type": "commonjs" }' > "$here/pkg-node/package.json" # the nodejs target emits CommonJS
wasm-bindgen --target web --out-dir "$here/pkg-web" "$wasm"
shasum -a 256 "$here"/pkg-node/*.wasm "$here"/pkg-web/*.wasm
