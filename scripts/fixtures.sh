#!/usr/bin/env bash
# Read-only mainnet snapshots for the local program tests. Never sends a transaction.
#
#   scripts/fixtures.sh                     dump the GMTrade program binary (gitignored)
#   scripts/fixtures.sh --refresh-accounts  also re-snapshot the committed account fixtures
#
# RPC: $MAINNET_RPC_URL, default the public endpoint (rate-limited; this makes ~25 requests).
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
RPC="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
OUT=tests/program/fixtures
GMTRADE_PROGRAM=Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo
# sha256 of the deployed v0.10.0 binary (OtterSec-verified build of commit 665fe60a, deployed 2026-08-12).
GMTRADE_SHA256=6056a8450231181812bc85c3dd3a60f83fe23400f1a4214f712965ca6fe7d20a

ACCOUNTS=(
  CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN # GMTrade store
  Hp7Eh2E815tDBpt1Ny1J4UgBLpnoKFzuh3L3uHxPaLEH # store wallet PDA ["store_wallet", store]
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v # USDC mint
  CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ # SOL/USD[USDC-USDC]
  6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc #   its market token
  4tM9cPqNpEYmstNdJMCc6rwdq42939w1SRFYoqMsqPQF # BTC/USD[USDC-USDC]
  Dqq58gS1TgRMDouUbdvhhzc51XXTNHG921WLxH9X2eB8 #   its market token
  6EnZdBzJsGznoh857PuhbrnrzWYGtZe6xMZiQjAPyFGT # ETH/USD[USDC-USDC]
  DAY6Qr1FKgJQFvjJAhFUZUWHzx8UbbbkRmt6G6AYswWG #   its market token
  59uFARJWg7B8wcEuXzvkafiT4DuKemdNCN5bshDbwun9 # XAU/USD[USDC-USDC]
  HCEitzjS88T4x3EpZ14EkrcawbhnZdev48a2nQfwAi37 #   its market token
  8FHYNS58cXSM1xYDGDq88jHzHoKmbqEDaVnXywqXdAkT # NVDA/USD[USDC-USDC]
  Gi1dxHsgnVLg1JQYqKDWsTfXD9U9GvhPJDg7Has266FL #   its market token
  HGEj3sGX2f7AAWUKE3AKtJuG7SZYi3N8argbFc4fk37V # EUR/USD[USDC-USDC]
  DLX3Aa17ebmyRp6Paxe16wn3QYtNVqdNH9AM9ZKLScfy #   its market token
  3M4vW1u8RT3HJSWqgEN1WuiUJZuVjJLQYEWvCHCuk56g # SOL/USD[WSOL-USDC] (not pure: must be refused)
  7roEjQEYB9AT43HTfQfPWVJ1MZ6ee3XMAs1BPRkaeBPF # open BTC long Position (layout check)
  Hix3KU7RASFw4Q3jubUB71rzCWHMG2VaGXitjuE8S9cg # open BTC short Position (layout check)
  12ejcFf7NkARnTXF1vjHvatQBYwjidkCzNZBAvjW5Vtc # flat BTC Position (layout check)
)

mkdir -p "$OUT/accounts"
solana program dump --url "$RPC" "$GMTRADE_PROGRAM" "$OUT/gmsol_store.so" >/dev/null
actual=$(shasum -a 256 "$OUT/gmsol_store.so" | cut -d' ' -f1)
if [[ "$actual" != "$GMTRADE_SHA256" ]]; then
  echo "GMTrade binary changed on mainnet: sha256 $actual (expected $GMTRADE_SHA256)." >&2
  echo "The program was upgraded; re-verify props_vault against it before trusting the tests." >&2
  exit 1
fi
echo "gmsol_store.so: v0.10.0 binary verified ($actual)"

# The gmsol-store v0.10.0 IDL shipped in the gmsol-programs crate: tests decode GMTrade accounts with it.
crate_manifest=$(cargo metadata --format-version 1 --manifest-path Cargo.toml |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).packages.find(p=>p.name==="gmsol-programs"&&p.version==="0.10.0").manifest_path))')
cp "$(dirname "$crate_manifest")/idls/gmsol_store.json" "$OUT/gmsol_store.idl.json"
echo "gmsol_store.idl.json: copied from gmsol-programs 0.10.0"

if [[ "${1:-}" == "--refresh-accounts" ]]; then
  for address in "${ACCOUNTS[@]}"; do
    solana account --url "$RPC" "$address" --output json --output-file "$OUT/accounts/$address.json" >/dev/null
    sleep 0.3
  done
  echo "refreshed ${#ACCOUNTS[@]} account snapshots in $OUT/accounts"
fi
