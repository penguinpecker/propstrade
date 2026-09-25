// Plan contract for the hot queries (docs/ARCHITECTURE.md §8, Postgres): EXPLAIN (no ANALYZE) against the migrated
// schema, with sequential scans priced out, must use the index each query was measured on at production volume, so a
// migration cannot silently drop one; where the index also gives the requested order, the plan must not sort. The SQL
// mirrors the module's drizzle query (named per row); a write is only planned, never run.
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './db.js';

const sql = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} }); // one connection, so the SET below sticks
beforeAll(async () => { await sql`set enable_seqscan = off`; });
afterAll(() => sql.end());

const PENDING = ['awaiting_execution', 'awaiting_price'];
const since = new Date('2026-09-01T00:00:00Z');
const uuid = '00000000-0000-4000-8000-000000000000';

/** [module: query, sql, params, index the plan must use (one of, where two tie on an empty table), whether a Sort
 *  node is acceptable (default: no)] */
const HOT: [string, string, unknown[], string | string[], boolean?][] = [
  ['auth: session of a request', `select id, wallet, expires_at from sessions where token_hash = $1 and expires_at > now()`, ['a'.repeat(64)], 'sessions_token_hash_unique'],
  ['auth: expired sessions of a wallet', `delete from sessions where wallet = $1 and expires_at < now()`, ['w'], 'sessions_wallet_idx'],
  ['auth: nonce purge', `delete from auth_nonces where expires_at < now() - interval '1 hour'`, [], 'auth_nonces_expires_at_idx'],
  ['account: notifications of a wallet', `select * from notifications where wallet = $1 order by created_at desc limit 100`, ['w'], 'notifications_wallet_created_idx', true],
  ['account: latest kyc request of a wallet', `select status from kyc_requests where wallet = $1 order by created_at desc limit 1`, ['w'], 'kyc_requests_wallet_created_idx'],
  ['sim book: accounts visible to a wallet', `select id from accounts where wallet = $1 and (stage = 'evaluation' or id = $2) order by created_at`, ['w', 'practice:w'], 'accounts_wallet_idx', true],
  ['sim book: open positions of an account', `select * from sim_positions where account_id = $1 and closed_at is null order by opened_at`, ['a'], 'sim_positions_open_uq', true],
  ['sim book: pending orders of an account', `select * from sim_orders where account_id = $1 and status in ($2, $3) order by created_at`, ['a', ...PENDING], 'sim_orders_pending_idx', true],
  ['sim book: last 50 finished orders', `select * from sim_orders where account_id = $1 and not status in ($2, $3) order by updated_at desc limit 50`, ['a', ...PENDING], 'sim_orders_account_status_idx', true],
  ['sim book: order by client id', `select * from sim_orders where account_id = $1 and client_id = $2`, ['a', 'c'], ['sim_orders_client_uq', 'sim_orders_account_status_idx']],
  ['sim read: closed trades of an account', `select * from closed_trades where account_id = $1 order by closed_at desc`, ['a'], 'closed_trades_account_closed_idx'],
  ['sim read: activity of an account', `select * from account_events where account_id = $1 order by ts desc limit 200`, ['a'], 'account_events_account_ts_idx'],
  ['sim read: equity series since', `select * from equity_snapshots where account_id = $1 and ts >= $2 order by ts`, ['a', since], 'equity_snapshots_account_id_ts_pk'],
  ['sim read: fills of an account since', `select * from sim_fills where account_id = $1 and ts >= $2`, ['a', since], 'sim_fills_account_ts_idx'],
  ['sim engine: pending orders of an account in a market (fill step)', `select * from sim_orders where account_id = $1 and symbol = $2 and status in ($3, $4) order by created_at`, ['a', 'SOL', ...PENDING], 'sim_orders_pending_idx', true],
  ['sim engine: open position of account, market, side', `select * from sim_positions where account_id = $1 and symbol = $2 and side = $3 and closed_at is null`, ['a', 'SOL', 'Long'], 'sim_positions_open_uq'],
  ['sim engine: protection armed by an order', `update sim_orders set position_id = $2 where parent_order_id = $1 and status in ($3, $4)`, [uuid, uuid, ...PENDING], 'sim_orders_pending_idx'],
  ['sim engine: pending orders of a position', `update sim_orders set status = 'canceled' where position_id = $1 and status in ($2, $3)`, [uuid, ...PENDING], 'sim_orders_pending_idx'],
  ['sim engine: fills of a closed position (round trip)', `select * from sim_fills where position_id = $1`, [uuid], 'sim_fills_position_idx'],
  ['sim rules: every open position', `select * from sim_positions where closed_at is null order by opened_at`, [], 'sim_positions_open_uq', true],
  ['sim rules: every pending order', `select * from sim_orders where status in ($1, $2) order by created_at`, [...PENDING], 'sim_orders_pending_idx', true],
  ['funded: accounts of a wallet', `select * from accounts a inner join funded_accounts f on f.address = a.id where a.wallet = $1 and a.stage = 'funded' order by a.created_at desc`, ['w'], 'accounts_wallet_idx', true],
  ['funded: open orders of an account', `select * from gm_orders where funded_account = $1 and closed_at is null order by created_at`, ['f'], 'gm_orders_funded_status_idx', true],
  ['funded: opening fill of a position', `select ts from venue_fills where position = $1 and is_increase = true order by venue_id desc limit 1`, ['p'], 'venue_fills_position_venue_id_idx'],
  ['funded: latest snapshot of a position', `select ts from gm_position_snapshots where position = $1 order by slot desc limit 1`, ['p'], 'gm_position_snapshots_position_slot_pk'],
  ['funded: last equity point of an account', `select * from equity_snapshots where account_id = $1 order by ts desc limit 1`, ['f'], 'equity_snapshots_account_id_ts_pk'],
  ['funded: payouts of a wallet', `select p.* from payouts p inner join accounts a on a.id = p.funded_account where a.wallet = $1 order by p.requested_at desc`, ['w'], 'payouts_funded_seq_uq', true],
  ['venue: sync cursor of an account', `select max(venue_id) from venue_fills where funded_account = $1`, ['f'], 'venue_fills_funded_venue_id_idx'],
  ['venue: fills of a round trip', `select * from venue_fills where funded_account = $1 and position = $2 and venue_id <= $3 and venue_id > $4 order by venue_id`, ['f', 'p', '9', '1'], 'venue_fills_position_venue_id_idx'],
  ['venue: positions an account has had', `select distinct position from gm_position_snapshots where funded_account = $1`, ['f'], 'gm_position_snapshots_funded_position_idx'],
  ['venue: unsettled orders of an account', `select address from gm_orders where funded_account = $1 and (closed_at is null or status in ('awaiting_execution', 'awaiting_price') or (status = 'unknown' and closed_at > $2))`, ['f', since], 'gm_orders_funded_status_idx'],
  ['projector: last snapshot of a market side', `select size_usd from gm_position_snapshots where funded_account = $1 and market_token = $2 and side = 'Long' order by slot desc limit 1`, ['f', 'm'], 'gm_position_snapshots_funded_idx'],
  ['keeper: last paid payout of an account', `select max(requested_at) from payouts where funded_account = $1 and status = 'paid'`, ['f'], 'payouts_funded_seq_uq'],
  ['keeper: fills of an account since a payout', `select * from venue_fills where funded_account = $1 and ts > $2`, ['f', since], ['venue_fills_funded_ts_idx', 'venue_fills_funded_venue_id_idx']],
  ['keeper: failed jobs', `select * from chain_jobs where status = 'failed' and updated_at > $1`, [since], 'chain_jobs_status_created_idx'],
  ['jobs: done by an indexed event', `select signature from program_events where name = $1 and data->>'evaluation' = $2 order by slot desc limit 1`, ['evaluationResolved', 'e'], 'program_events_name_slot_idx'],
  ['jobs: decision per subject', `insert into chain_jobs (kind, payload, subject, mac) values ('lift_restriction', '{}', $1, $2) on conflict (subject) do update set status = 'queued' where chain_jobs.status = 'failed'`, ['s', 'a'.repeat(64)], 'chain_jobs_subject_uq'],
  ['verify: events of a transaction', `select * from program_events where signature = $1 order by event_index`, ['s'], 'program_events_signature_event_index_pk'],
  ['charts: minutes of a market as candles', `select (t / 60) * 60, max(high), min(low) from price_bars where symbol = $1 and t >= $2 and t < $3 group by 1 order by 1`, ['SOL', 1, 2], 'price_bars_symbol_t_pk', true],
  ['charts: settled windows of a series overlapping a range', `select candles from candle_windows where symbol = $1 and resolution = $2 and settled and start_time <= $3 and end_time >= $4`, ['SOL', 3600, 2, 1], 'candle_windows_symbol_resolution_start_time_pk'],
  ['charts: settled windows of a series in order', `select start_time, end_time from candle_windows where symbol = $1 and resolution = $2 and settled order by start_time`, ['SOL', 300], 'candle_windows_symbol_resolution_start_time_pk'],
];

/** Whether the plan reads through `index` (a scan) or resolves an upsert's conflict on it (the arbiter). */
const uses = (plan: string, index: string) => plan.includes(`"Index Name":"${index}"`) || plan.includes(`"Conflict Arbiter Indexes":["${index}"]`);

for (const [what, text, params, index, sortOk] of HOT) {
  it(`${what} — ${[index].flat().join(' | ')}`, async () => {
    const [row] = await sql.unsafe(`explain (format json) ${text}`, params as never[]);
    const plan = JSON.stringify(row!['QUERY PLAN']);
    expect([index].flat().some((name) => uses(plan, name)), plan).toBe(true);
    expect(plan, plan).not.toContain('"Node Type":"Seq Scan"');
    if (!sortOk) expect(plan, plan).not.toContain('"Node Type":"Sort"');
  });
}
