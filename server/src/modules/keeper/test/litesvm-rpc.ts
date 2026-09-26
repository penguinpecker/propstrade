// A Solana node over a LiteSVM environment (tests/program/src/env.ts: the mainnet GMTrade binary and the props_vault
// binary under test): the part of the web3.js Connection API the chain module's indexer, venue loop and job executor and
// the keeper call. Every transaction, the environment's own included, is kept with its result, so the indexer pages and
// fetches them as from a real node, and program accounts are found among the accounts those transactions touched.
// Blockhashes are unique per request and never expire (LiteSVM's blockhash check is off; signatures are still checked).
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction, type AccountInfo, type ConfirmedSignatureInfo, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { FailedTransactionMetadata, type Env } from '../../../../../tests/program/src/env.ts';

type Failed = InstanceType<typeof FailedTransactionMetadata>;
type Meta = { logs(): string[]; computeUnitsConsumed(): bigint; innerInstructions(): { instruction(): { programIdIndex(): number; accounts(): Uint8Array; data(): Uint8Array }; stackHeight(): number }[][] };
type Result = Meta | Failed;
interface Inner {
  sendLegacyTransaction(raw: Uint8Array): Result;
  sendVersionedTransaction(raw: Uint8Array): Result;
  simulateLegacyTransaction(raw: Uint8Array): { meta(): Meta } | Failed;
  simulateVersionedTransaction(raw: Uint8Array): { meta(): Meta } | Failed;
  setBlockhashCheck(on: boolean): void;
}
interface Landed { signature: string; slot: number; blockTime: number; tx: VersionedTransaction; err: object | null; meta: Meta }

type Filter = { dataSize: number } | { memcmp: { offset: number; bytes: string; encoding?: 'base58' | 'base64' } };

export function liteSvmRpc(env: Env) {
  const inner = (env.svm as unknown as { inner: Inner }).inner;
  inner.setBlockhashCheck(false);
  const landed = new Map<string, Landed>();
  const newestFirst: string[] = [];
  const touched = new Set<string>();
  let slot = 1_000;
  let blockhashes = 0;

  const accountInfo = (key: PublicKey): AccountInfo<Buffer> | null => {
    const a = env.svm.getAccount(key);
    return a && a.lamports > 0 ? { ...a, data: Buffer.from(a.data) } : null;
  };
  const failure = (r: Failed) => ({ failed: r.err().toString() });

  function keep(raw: Uint8Array, result: Result): string {
    const tx = VersionedTransaction.deserialize(raw);
    const signature = bs58.encode(tx.signatures[0]!);
    for (const k of tx.message.staticAccountKeys) touched.add(k.toBase58());
    const failed = result instanceof FailedTransactionMetadata;
    landed.set(signature, { signature, slot: slot++, blockTime: Math.floor(Date.now() / 1000), tx, err: failed ? failure(result) : null, meta: failed ? result.meta() as Meta : result });
    newestFirst.unshift(signature);
    return signature;
  }

  // The environment's own sends (setUpVault, activeFunded, a trader's orders) are transactions like any other.
  const send = env.svm.sendTransaction.bind(env.svm);
  env.svm.sendTransaction = (tx: Transaction) => {
    const result = send(tx);
    keep(tx.serialize(), result as Result);
    return result;
  };

  const rpc = {
    commitment: 'confirmed' as const,
    rpcEndpoint: 'http://litesvm',
    landed,
    async getLatestBlockhash() {
      const blockhash = bs58.encode(createHash('sha256').update(`blockhash ${blockhashes++}`).digest());
      return { blockhash, lastValidBlockHeight: 1_000_000 };
    },
    async getBlockHeight() {
      return 1;
    },
    async getSlot() {
      return slot;
    },
    async simulateTransaction(tx: VersionedTransaction) {
      const raw = tx.serialize();
      const r = tx.version === 'legacy' ? inner.simulateLegacyTransaction(raw) : inner.simulateVersionedTransaction(raw);
      const meta = r.meta();
      return { context: { slot }, value: { err: r instanceof FailedTransactionMetadata ? failure(r) : null, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()), accounts: null } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      const tx = VersionedTransaction.deserialize(raw);
      const signature = bs58.encode(tx.signatures[0]!);
      if (landed.has(signature)) return signature; // a resend changes nothing
      return keep(raw, tx.version === 'legacy' ? inner.sendLegacyTransaction(raw) : inner.sendVersionedTransaction(raw));
    },
    async getSignatureStatuses(signatures: string[]) {
      return { context: { slot }, value: signatures.map((s) => {
        const l = landed.get(s);
        return l ? { slot: l.slot, confirmations: null, err: l.err, confirmationStatus: 'confirmed' as const } : null;
      }) };
    },
    async getRecentPrioritizationFees() {
      return [];
    },
    async getAccountInfo(key: PublicKey, config?: { dataSlice?: { offset: number; length: number } }) {
      const a = accountInfo(key);
      return a && config?.dataSlice ? { ...a, data: a.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) } : a;
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map(accountInfo);
    },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      return { context: { slot }, value: keys.map(accountInfo) };
    },
    async getTokenAccountBalance(key: PublicKey) {
      const a = accountInfo(key);
      if (!a) throw new Error(`could not find account ${key.toBase58()}`);
      const amount = a.data.readBigUInt64LE(64).toString();
      return { context: { slot }, value: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: (Number(amount) / 1e6).toString() } };
    },
    /** Program accounts among those any kept transaction touched, with the filters and slice a node applies. */
    async getProgramAccounts(program: PublicKey, config: { filters?: Filter[]; dataSlice?: { offset: number; length: number } } = {}) {
      const out: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
      for (const key of touched) {
        const pubkey = new PublicKey(key);
        const a = accountInfo(pubkey);
        if (!a || !a.owner.equals(program)) continue;
        const matches = (config.filters ?? []).every((f) => {
          if ('dataSize' in f) return a.data.length === f.dataSize;
          const bytes = f.memcmp.encoding === 'base64' ? Buffer.from(f.memcmp.bytes, 'base64') : Buffer.from(bs58.decode(f.memcmp.bytes));
          return a.data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes);
        });
        if (!matches) continue;
        const data = config.dataSlice ? a.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) : a.data;
        out.push({ pubkey, account: { ...a, data } });
      }
      return out;
    },
    async getSignaturesForAddress(address: PublicKey, o: { before?: string; until?: string; limit?: number } = {}): Promise<ConfirmedSignatureInfo[]> {
      const list = newestFirst.filter((s) => landed.get(s)!.tx.message.staticAccountKeys.some((k) => k.equals(address)));
      let start = o.before ? list.indexOf(o.before) + 1 : 0;
      const stop = o.until ? list.indexOf(o.until) : -1;
      const end = stop === -1 ? list.length : stop;
      start = Math.min(start, end);
      return list.slice(start, Math.min(end, start + (o.limit ?? 1_000))).map((s) => {
        const l = landed.get(s)!;
        return { signature: s, slot: l.slot, err: l.err, memo: null, blockTime: l.blockTime };
      });
    },
    async getTransaction(signature: string) {
      const l = landed.get(signature);
      if (!l) return null;
      return {
        slot: l.slot, blockTime: l.blockTime,
        transaction: { message: l.tx.message, signatures: l.tx.signatures.map((s) => bs58.encode(s)) },
        meta: {
          err: l.err, fee: 5_000, logMessages: l.meta.logs(), computeUnitsConsumed: Number(l.meta.computeUnitsConsumed()),
          loadedAddresses: { writable: [], readonly: [] },
          innerInstructions: l.meta.innerInstructions().map((list, index) => ({
            index,
            instructions: list.map((ii) => ({
              programIdIndex: ii.instruction().programIdIndex(), accounts: [...ii.instruction().accounts()], data: bs58.encode(ii.instruction().data()),
              stackHeight: ii.stackHeight(),
            })),
          })).filter((g) => g.instructions.length),
        },
      };
    },
    onLogs() {
      return 0;
    },
    async removeOnLogsListener() {},
  };
  return rpc;
}
