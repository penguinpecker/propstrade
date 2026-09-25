// The SDK's GMTrade offsets (mirrors of programs/props_vault/src/gmtrade.rs) against GMTrade's own IDL
// decoder on real mainnet accounts. The program's offsets are checked the same way by `cargo test`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { GMTRADE_PROGRAM_ID, GMTRADE_STORE, decodeGmMarketMeta, decodeGmPosition } from '@props/sdk';
import { Env, MAINNET_POSITIONS, MARKETS, NON_PURE_MARKET } from './env.ts';

describe('GMTrade layouts', () => {
  const env = new Env();

  it('decodes mainnet Position accounts like the gmsol-store IDL', () => {
    for (const address of Object.values(MAINNET_POSITIONS)) {
      const ours = decodeGmPosition(env.svm.getAccount(address)!.data);
      const idl = env.gm('Position', address);
      assert.equal(ours.sizeInUsd, BigInt(idl.state.size_in_usd.toString()));
      assert.equal(ours.collateralAmount, BigInt(idl.state.collateral_amount.toString()));
      assert.equal(ours.sizeInTokens, BigInt(idl.state.size_in_tokens.toString()));
      assert.ok(ours.owner.equals(idl.owner) && ours.marketToken.equals(idl.market_token) && ours.store.equals(GMTRADE_STORE));
      assert.equal(ours.isLong, idl.kind === 1);
      const pda = PublicKey.createProgramAddressSync(
        [Buffer.from('position'), ours.store.toBuffer(), ours.owner.toBuffer(), ours.marketToken.toBuffer(), ours.collateralToken.toBuffer(), Buffer.from([idl.kind]), Buffer.from([idl.bump])],
        GMTRADE_PROGRAM_ID,
      );
      assert.ok(pda.equals(address), 'offsets reproduce the account address');
    }
    assert.ok(decodeGmPosition(env.svm.getAccount(MAINNET_POSITIONS.long)!.data).sizeInUsd > 0n);
    assert.equal(decodeGmPosition(env.svm.getAccount(MAINNET_POSITIONS.flat)!.data).sizeInUsd, 0n);
    assert.throws(() => decodeGmPosition(env.svm.getAccount(MARKETS.SOL.gm)!.data), /not an exchange Position/);
  });

  it('reads market meta and flags like the gmsol-store IDL', () => {
    for (const m of Object.values(MARKETS)) {
      const meta = decodeGmMarketMeta(env.svm.getAccount(m.gm)!.data);
      const idl = env.gm('Market', m.gm);
      assert.ok(meta.marketToken.equals(m.token) && meta.marketToken.equals(idl.meta.market_token_mint));
      assert.equal(meta.name, Buffer.from(idl.name).toString('utf8').replace(/\0+$/, ''));
      assert.match(meta.name, /\[USDC-USDC\]$/);
      assert.ok(meta.indexToken.equals(idl.meta.index_token_mint));
      assert.equal(meta.enabled, (idl.flags.value & 1) === 1);
      assert.equal(meta.closed, (idl.flags.value & 32) === 32);
      assert.ok(meta.pureUsdc && meta.store.equals(GMTRADE_STORE));
    }
    assert.equal(decodeGmMarketMeta(env.svm.getAccount(NON_PURE_MARKET)!.data).pureUsdc, false);
  });
});
