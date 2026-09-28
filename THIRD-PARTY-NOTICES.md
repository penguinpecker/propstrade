# Third-party notices

1. `packages/gmsol-wasm/pkg-node/`, `packages/gmsol-wasm/pkg-web/` and `packages/gmtrade/idl/gmsol_store-0.10.0.json`
   are compiled from, or copied from, GMTrade's gmx-solana repository, release v0.10.0, licensed by gmxresearch.eth under
   the Business Source License 1.1. The licence text and the details of the one modification are in
   `packages/gmsol-wasm/LICENSE-GMTRADE`, `packages/gmsol-wasm/NOTICE`, `packages/gmtrade/idl/LICENSE-GMTRADE` and
   `packages/gmtrade/idl/NOTICE`. That material is not covered by the licence of the Props.trade code.
2. `programs/props_vault` and `research/spike-vault` link the `gmsol-programs` 0.10.0 crate from crates.io, under the
   same Business Source License 1.1.
3. The web app's bundled JavaScript packages: their licence texts are generated at build time into
   `/third-party-licenses.txt`; hand-kept notices (TradingView Lightweight Charts, Manrope, Lucide, Reown/WalletConnect)
   are in `app/public/third-party-notices.txt` and linked from the app's footer.
4. Props.trade's own code: see `LICENSE` once added; until then all rights are reserved.
