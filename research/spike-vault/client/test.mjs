// Local-only spike check: props_vault PDA owns GMTrade orders via CPI on a mainnet-clone test validator.
// Never talks to mainnet except (optionally) --clone-feature-set, which is a read.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RPC = "http://127.0.0.1:8899";
const CLONE_FEATURES = process.env.CLONE_FEATURES !== "0";
const STORE_SO = process.env.STORE_SO || `${ROOT}/fixtures/gmsol_store.so`; // default: mainnet dump (v0.10.0)
const TAG = process.env.RUN_TAG || "mainnet_v0.10.0";

const STORE_PROGRAM = new PublicKey("Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo");
const STORE = new PublicKey("CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN");
const MARKET = new PublicKey("CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ"); // SOL/USD[USDC-USDC]
const MARKET_TOKEN = new PublicKey("6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const STORE_WALLET = new PublicKey("Hp7Eh2E815tDBpt1Ny1J4UgBLpnoKFzuh3L3uHxPaLEH");
const USD = 10n ** 20n; // MARKET_USD_UNIT (gmsol-store constants/mod.rs:40)

const idl = JSON.parse(fs.readFileSync(`${ROOT}/target/idl/props_vault.json`));
const storeIdl = JSON.parse(fs.readFileSync(`${ROOT}/ref/gmsol_store.idl.json`));
const PROGRAM_ID = new PublicKey(idl.address);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${ROOT}/keys/payer.json`))));

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ID = 1n;
const vaultState = pda([Buffer.from("vault_state"), payer.publicKey.toBuffer(), le64(ID)], PROGRAM_ID);
const funded = pda([Buffer.from("funded"), vaultState.toBuffer(), le64(ID)], PROGRAM_ID);
const user = pda([Buffer.from("user"), STORE.toBuffer(), funded.toBuffer()], STORE_PROGRAM);
const eventAuthority = pda([Buffer.from("__event_authority")], STORE_PROGRAM);
const positionFor = (isLong) => pda([Buffer.from("position"), STORE.toBuffer(), funded.toBuffer(),
  MARKET_TOKEN.toBuffer(), USDC.toBuffer(), Buffer.from([isLong ? 1 : 2])], STORE_PROGRAM);
const orderFor = (nonce) => pda([Buffer.from("order"), STORE.toBuffer(), funded.toBuffer(), nonce], STORE_PROGRAM);
const ata = (owner, mint) => getAssociatedTokenAddressSync(mint, owner, true);
const source = ata(funded, USDC);

// Pre-seed the PDA's USDC ATA (we cannot mint real USDC): SPL token account, 165 bytes.
const SEED_USDC = 1_000_000_000n; // 1,000 USDC
// Mainnet snapshots -> validator fixtures. ONE patch: Store.last_restarted_slot (byte 4800) := 0.
// Mainnet's LastRestartSlot sysvar is 246464040 (== the stored value), the local validator's is 0;
// gmsol-store validate_not_restarted (states/store.rs:417) requires them equal.
const STORE_LAST_RESTART_OFFSET = 4800;
function writeFixtures() {
  for (const f of fs.readdirSync(`${ROOT}/fixtures/mainnet`)) {
    let raw = fs.readFileSync(`${ROOT}/fixtures/mainnet/${f}`, "utf8"); // keep raw text: rentEpoch is u64::MAX
    const j = JSON.parse(raw);
    if (j.pubkey === STORE.toBase58()) {
      const d = Buffer.from(j.account.data[0], "base64");
      assert.equal(d.readBigUInt64LE(STORE_LAST_RESTART_OFFSET), 246464040n, "unexpected Store layout");
      d.writeBigUInt64LE(0n, STORE_LAST_RESTART_OFFSET);
      raw = raw.replace(j.account.data[0], d.toString("base64"));
    }
    fs.writeFileSync(`${ROOT}/fixtures/accounts/${f}`, raw);
  }
  writeSourceFixture();
}
function writeSourceFixture() {
  const d = Buffer.alloc(165);
  USDC.toBuffer().copy(d, 0); funded.toBuffer().copy(d, 32); d.writeBigUInt64LE(SEED_USDC, 64);
  d[108] = 1; // state = Initialized
  fs.writeFileSync(`${ROOT}/fixtures/accounts/source_ata.json`, JSON.stringify({
    pubkey: source.toBase58(),
    account: { lamports: 2039280, data: [d.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false, rentEpoch: 0, space: 165 },
  }));
}

async function startValidator() {
  const args = ["--reset", "--quiet", "--ledger", `${ROOT}/test-ledger`, "--rpc-port", "8899", "--faucet-port", "9900",
    "--upgradeable-program", STORE_PROGRAM.toBase58(), STORE_SO, "none",
    "--upgradeable-program", PROGRAM_ID.toBase58(), `${ROOT}/target/deploy/props_vault.so`, "none",
    "--account-dir", `${ROOT}/fixtures/accounts`];
  if (CLONE_FEATURES) args.push("--clone-feature-set", "--url", "https://api.mainnet-beta.solana.com");
  const v = spawn("solana-test-validator", args, { stdio: ["ignore", "inherit", "inherit"] });
  const c = new Connection(RPC, "confirmed");
  let dead = false; v.on("exit", () => { dead = true; });
  for (let i = 0; i < 120 && !dead; i++) {
    try { await c.getSlot(); return v; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  v.kill(); throw new Error("validator did not start");
}

const results = [];
async function send(conn, label, ixs, cu = 1_400_000) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const raw = tx.serialize();
  const msg = tx.compileMessage();
  let sig;
  try {
    sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
  } catch (e) { console.error(label, "send error", e); throw e; }
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const r = { label, sig, ok: !t.meta.err, err: t.meta.err, cu: t.meta.computeUnitsConsumed, txBytes: raw.length,
    accounts: msg.accountKeys.length, feeLamports: t.meta.fee };
  results.push(r);
  console.log(JSON.stringify({ ...r, sig: sig.slice(0, 16) + "…" }));
  if (!r.ok) { console.log(t.meta.logMessages.join("\n")); throw new Error(`${label} failed: ${JSON.stringify(t.meta.err)}`); }
  fs.writeFileSync(`${ROOT}/logs/${TAG}.${label}.log`, t.meta.logMessages.join("\n"));
  return t;
}

const tokAmount = async (conn, a) => {
  const i = await conn.getAccountInfo(a); return i ? i.data.readBigUInt64LE(64) : null;
};

async function main() {
  fs.mkdirSync(`${ROOT}/logs`, { recursive: true });
  writeFixtures();
  const v = await startValidator();
  try {
    const conn = new Connection(RPC, "confirmed");
    await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
    const program = new anchor.Program(idl, provider);
    const storeCoder = new anchor.BorshAccountsCoder(storeIdl);

    // Sanity: cloned program + accounts present.
    const sp = await conn.getAccountInfo(STORE_PROGRAM);
    assert.ok(sp?.executable, "gmsol_store not loaded");
    const mkt = storeCoder.decode("Market", (await conn.getAccountInfo(MARKET)).data);
    assert.equal(new PublicKey(mkt.meta.long_token_mint).toBase58(), USDC.toBase58());

    // a) init_funded
    await send(conn, "init_funded", [await program.methods.initFunded(new anchor.BN(ID.toString()))
      .accountsPartial({ authority: payer.publicKey, vaultState, fundedSigner: funded }).instruction()]);
    const fundedInfo0 = await conn.getAccountInfo(funded);
    assert.equal(fundedInfo0, null, "funded PDA should not exist yet (data-less, unfunded)");

    // fund PDA with SOL (plain system transfer)
    await send(conn, "fund_pda", [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: funded, lamports: 0.1 * LAMPORTS_PER_SOL })]);

    // b) open: MarketIncrease long, $20 size, 10 USDC collateral
    const nonce = Buffer.alloc(32, 7);
    const order = orderFor(nonce);
    const escrow = ata(order, USDC);
    const position = positionFor(true);
    const collateral = 10_000_000n;
    const lam0 = await conn.getBalance(funded);
    const src0 = await tokAmount(conn, source);
    await send(conn, "open", [await program.methods
      .open([...nonce], new anchor.BN((20n * USD).toString()), new anchor.BN(collateral.toString()), true)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: MARKET, user, position, order,
        collateralMint: USDC, collateralSource: source, collateralEscrow: escrow, longToken: USDC, shortToken: USDC,
        longTokenEscrow: escrow, shortTokenEscrow: escrow, eventAuthority, storeProgram: STORE_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction()]);

    const oi = await conn.getAccountInfo(order);
    assert.ok(oi, "order account missing");
    assert.equal(oi.owner.toBase58(), STORE_PROGRAM.toBase58(), "order not owned by gmsol_store");
    const od = storeCoder.decode("Order", oi.data);
    const h = od.header;
    assert.equal(new PublicKey(h.owner).toBase58(), funded.toBase58(), "order.header.owner != PDA");
    assert.equal(new PublicKey(h.receiver).toBase58(), funded.toBase58(), "order.header.receiver != PDA");
    assert.equal(new PublicKey(h.rent_receiver).toBase58(), funded.toBase58());
    assert.equal(od.params.kind, 3, "kind != MarketIncrease");
    assert.equal(BigInt(od.params.initial_collateral_delta_amount.toString()), collateral);
    assert.equal(BigInt(od.params.size_delta_value.toString()), 20n * USD);
    assert.equal(await tokAmount(conn, escrow), collateral, "escrow USDC != collateral");
    assert.equal(await tokAmount(conn, source), src0 - collateral, "source not debited");
    const posInfo = await conn.getAccountInfo(position);
    assert.equal(posInfo.owner.toBase58(), STORE_PROGRAM.toBase58());
    const pos = storeCoder.decode("Position", posInfo.data);
    assert.equal(new PublicKey(pos.owner).toBase58(), funded.toBase58(), "position.owner != PDA");
    const userInfo = await conn.getAccountInfo(user);
    assert.equal(new PublicKey(storeCoder.decode("UserHeader", userInfo.data).owner).toBase58(), funded.toBase58());
    const lam1 = await conn.getBalance(funded);
    const fundedInfo1 = await conn.getAccountInfo(funded);
    assert.equal(fundedInfo1.owner.toBase58(), SystemProgram.programId.toBase58());
    assert.equal(fundedInfo1.data.length, 0, "funded PDA must stay data-less");
    console.log(JSON.stringify({ step: "open-state", order: order.toBase58(), orderId: h.id.toString(), escrow: escrow.toBase58(),
      escrowUsdc: String(await tokAmount(conn, escrow)), pdaLamportsSpent: lam0 - lam1, orderLamports: oi.lamports,
      positionLamports: posInfo.lamports, userLamports: userInfo.lamports }));

    // d) StopLossDecrease on the same position (created before the increase executes; keeper-only execution)
    const slNonce = Buffer.alloc(32, 9);
    const slOrder = orderFor(slNonce);
    const slEscrow = ata(slOrder, USDC);
    await send(conn, "place_stop_loss", [await program.methods
      .placeStopLoss([...slNonce], new anchor.BN((20n * USD).toString()), new anchor.BN((100n * USD).toString()), true)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: MARKET, user, position, order: slOrder,
        outputMint: USDC, outputEscrow: slEscrow, longToken: USDC, shortToken: USDC, longTokenEscrow: slEscrow, shortTokenEscrow: slEscrow,
        eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction()]);
    const sl = storeCoder.decode("Order", (await conn.getAccountInfo(slOrder)).data);
    assert.equal(sl.params.kind, 8, "kind != StopLossDecrease");
    assert.equal(new PublicKey(sl.header.owner).toBase58(), funded.toBase58());
    assert.equal(new PublicKey(sl.params.position).toBase58(), position.toBase58());

    // c) cancel both, owner = executor = receiver = rent_receiver = PDA
    const lamPreCancel = await conn.getBalance(funded);
    await send(conn, "cancel_increase", [await program.methods.cancel().accountsPartial({
      authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, storeWallet: STORE_WALLET, user, order,
      initialCollateralToken: USDC, finalOutputToken: USDC, longToken: USDC, shortToken: USDC,
      initialCollateralTokenEscrow: escrow, finalOutputTokenEscrow: null, longTokenEscrow: escrow, shortTokenEscrow: escrow,
      initialCollateralTokenAta: source, finalOutputTokenAta: null, longTokenAta: source, shortTokenAta: source,
      eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()]);
    assert.equal(await conn.getAccountInfo(order), null, "order not closed");
    assert.equal(await conn.getAccountInfo(escrow), null, "escrow not closed");
    assert.equal(await tokAmount(conn, source), src0, "USDC not returned to PDA ATA");
    const lamPostCancel = await conn.getBalance(funded);

    await send(conn, "cancel_stop_loss", [await program.methods.cancel().accountsPartial({
      authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, storeWallet: STORE_WALLET, user, order: slOrder,
      initialCollateralToken: null, finalOutputToken: USDC, longToken: USDC, shortToken: USDC,
      initialCollateralTokenEscrow: null, finalOutputTokenEscrow: slEscrow, longTokenEscrow: slEscrow, shortTokenEscrow: slEscrow,
      initialCollateralTokenAta: null, finalOutputTokenAta: source, longTokenAta: source, shortTokenAta: source,
      eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()]);
    assert.equal(await conn.getAccountInfo(slOrder), null, "SL order not closed");
    const lam2 = await conn.getBalance(funded);

    // negative: a stranger cannot drive the vault (has_one = authority)
    const stranger = Keypair.generate();
    let strangerBlocked = false;
    try {
      const ix = await program.methods.cancel().accountsPartial({
        authority: stranger.publicKey, vaultState, fundedSigner: funded, store: STORE, storeWallet: STORE_WALLET, user, order,
        initialCollateralToken: USDC, finalOutputToken: USDC, longToken: USDC, shortToken: USDC,
        initialCollateralTokenEscrow: escrow, finalOutputTokenEscrow: null, longTokenEscrow: escrow, shortTokenEscrow: escrow,
        initialCollateralTokenAta: source, finalOutputTokenAta: null, longTokenAta: source, shortTokenAta: source,
        eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction();
      const tx = new Transaction().add(ix); tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(payer, stranger);
      const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction(s, "confirmed");
      const t = await conn.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      strangerBlocked = !!t.meta.err && t.meta.logMessages.some((l) => l.includes("ConstraintHasOne"));
    } catch (e) { strangerBlocked = true; }
    assert.ok(strangerBlocked, "stranger was not blocked");

    console.log(JSON.stringify({ step: "cancel-state", usdcBack: String(await tokAmount(conn, source)),
      pdaLamports: { beforeOpen: lam0, afterOpen: lam1, beforeCancels: lamPreCancel, afterCancelIncrease: lamPostCancel, afterBothCancels: lam2 },
      netPdaSolLockedAfterRoundTrip: lam0 - lam2, strangerBlocked }));
    // Product flow check: open + stop-loss atomically in ONE legacy transaction (no lookup table).
    const n3 = Buffer.alloc(32, 3), n4 = Buffer.alloc(32, 4);
    const o3 = orderFor(n3), e3 = ata(o3, USDC), o4 = orderFor(n4), e4 = ata(o4, USDC);
    const openIx = await program.methods
      .open([...n3], new anchor.BN((20n * USD).toString()), new anchor.BN(collateral.toString()), true)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: MARKET, user, position, order: o3,
        collateralMint: USDC, collateralSource: source, collateralEscrow: e3, longToken: USDC, shortToken: USDC,
        longTokenEscrow: e3, shortTokenEscrow: e3, eventAuthority, storeProgram: STORE_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction();
    const slIx = await program.methods
      .placeStopLoss([...n4], new anchor.BN((20n * USD).toString()), new anchor.BN((100n * USD).toString()), true)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: MARKET, user, position, order: o4,
        outputMint: USDC, outputEscrow: e4, longToken: USDC, shortToken: USDC, longTokenEscrow: e4, shortTokenEscrow: e4,
        eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction();
    await send(conn, "open_plus_sl_one_tx", [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), openIx, slIx]);
    assert.equal(storeCoder.decode("Order", (await conn.getAccountInfo(o3)).data).params.kind, 3);
    assert.equal(storeCoder.decode("Order", (await conn.getAccountInfo(o4)).data).params.kind, 8);

    // Non-pure market: SOL/USD[WSOL-USDC], SHORT with USDC collateral (+ SL) in one tx, then owner-cancel both.
    const M2 = new PublicKey("3M4vW1u8RT3HJSWqgEN1WuiUJZuVjJLQYEWvCHCuk56g");
    const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
    const m2 = storeCoder.decode("Market", (await conn.getAccountInfo(M2)).data);
    assert.equal(new PublicKey(m2.meta.long_token_mint).toBase58(), WSOL.toBase58());
    assert.equal(new PublicKey(m2.meta.short_token_mint).toBase58(), USDC.toBase58());
    const m2Token = new PublicKey(m2.meta.market_token_mint);
    const pos2 = pda([Buffer.from("position"), STORE.toBuffer(), funded.toBuffer(), m2Token.toBuffer(), USDC.toBuffer(), Buffer.from([2])], STORE_PROGRAM);
    const n5 = Buffer.alloc(32, 5), n6 = Buffer.alloc(32, 6);
    const o5 = orderFor(n5), o6 = orderFor(n6);
    const [o5u, o5w, o6u, o6w] = [ata(o5, USDC), ata(o5, WSOL), ata(o6, USDC), ata(o6, WSOL)];
    const src1 = await tokAmount(conn, source);
    // First run showed the PDA float (0.1 SOL) is too small here: non-pure position prepay is larger. Top up.
    await send(conn, "fund_pda_topup", [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: funded, lamports: 0.1 * LAMPORTS_PER_SOL })]);
    const lamNp0 = await conn.getBalance(funded);
    const openShort = await program.methods
      .open([...n5], new anchor.BN((50n * USD).toString()), new anchor.BN(collateral.toString()), false)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: M2, user, position: pos2, order: o5,
        collateralMint: USDC, collateralSource: source, collateralEscrow: o5u, longToken: WSOL, shortToken: USDC,
        longTokenEscrow: o5w, shortTokenEscrow: o5u, eventAuthority, storeProgram: STORE_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction();
    const slShort = await program.methods
      .placeStopLoss([...n6], new anchor.BN((50n * USD).toString()), new anchor.BN((300n * USD).toString()), false)
      .accountsPartial({
        authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, market: M2, user, position: pos2, order: o6,
        outputMint: USDC, outputEscrow: o6u, longToken: WSOL, shortToken: USDC, longTokenEscrow: o6w, shortTokenEscrow: o6u,
        eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction();
    await send(conn, "nonpure_short_open_plus_sl_one_tx", [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), openShort, slShort]);
    const pos2Info = await conn.getAccountInfo(pos2);
    console.log(JSON.stringify({ step: "nonpure-open-state", pdaLamportsSpent: lamNp0 - await conn.getBalance(funded), positionLamports: pos2Info.lamports,
      o5Lamports: (await conn.getAccountInfo(o5)).lamports, o6Lamports: (await conn.getAccountInfo(o6)).lamports }));
    const od5 = storeCoder.decode("Order", (await conn.getAccountInfo(o5)).data);
    assert.equal(new PublicKey(od5.params.collateral_token).toBase58(), USDC.toBase58());
    assert.equal(new PublicKey(od5.header.owner).toBase58(), funded.toBase58());
    assert.equal(await tokAmount(conn, o5u), collateral);
    const pdaWsolAta = ata(funded, WSOL);
    await send(conn, "nonpure_cancel_increase", [await program.methods.cancel().accountsPartial({
      authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, storeWallet: STORE_WALLET, user, order: o5,
      initialCollateralToken: USDC, finalOutputToken: USDC, longToken: WSOL, shortToken: USDC,
      initialCollateralTokenEscrow: o5u, finalOutputTokenEscrow: null, longTokenEscrow: o5w, shortTokenEscrow: o5u,
      initialCollateralTokenAta: source, finalOutputTokenAta: null, longTokenAta: pdaWsolAta, shortTokenAta: source,
      eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()]);
    assert.equal(await conn.getAccountInfo(o5), null);
    assert.equal(await tokAmount(conn, source), src1, "USDC not returned (non-pure)");
    await send(conn, "nonpure_cancel_stop_loss", [await program.methods.cancel().accountsPartial({
      authority: payer.publicKey, vaultState, fundedSigner: funded, store: STORE, storeWallet: STORE_WALLET, user, order: o6,
      initialCollateralToken: null, finalOutputToken: USDC, longToken: WSOL, shortToken: USDC,
      initialCollateralTokenEscrow: null, finalOutputTokenEscrow: o6u, longTokenEscrow: o6w, shortTokenEscrow: o6u,
      initialCollateralTokenAta: null, finalOutputTokenAta: source, longTokenAta: pdaWsolAta, shortTokenAta: source,
      eventAuthority, storeProgram: STORE_PROGRAM, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()]);
    assert.equal(await conn.getAccountInfo(o6), null);
    console.log(JSON.stringify({ step: "nonpure", pdaWsolAtaExistsAfterCancel: !!(await conn.getAccountInfo(pdaWsolAta)), pdaLamportsEnd: await conn.getBalance(funded) }));

    fs.writeFileSync(`${ROOT}/logs/${TAG}.results.json`, JSON.stringify(results, null, 2));
    console.log("ALL ASSERTIONS PASSED");
  } finally {
    v.kill("SIGINT");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
