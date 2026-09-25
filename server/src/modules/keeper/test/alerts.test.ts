// Alert delivery: Telegram, Sentry (envelope API) and the heartbeat, each only when configured, with repeats throttled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from '../../chain/test/support.ts';
import { createAlerts } from '../alerts.ts';

function recorder() {
  const logged: [level: string, text: string][] = [];
  const log = {
    info: (_o: unknown, t?: string) => void logged.push(['info', t ?? String(_o)]),
    warn: (_o: unknown, t?: string) => void logged.push(['warn', t ?? String(_o)]),
    error: (_o: unknown, t?: string) => void logged.push(['error', t ?? String(_o)]),
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  return { logged, requests, log: log as never, fetch };
}
const settle = () => new Promise((r) => setImmediate(r));

test('an alert logs its severity under its own key: pino writes its numeric level first, and JSON readers keep the last duplicate', () => {
  const merged: object[] = [];
  const keep = (o: object) => void merged.push(o);
  const alerts = createAlerts({ env: {}, log: { info: keep, warn: keep, error: keep } as never });
  alerts.send('breach:F', 'critical', 'Funded account F reached its equity floor');
  assert.deepEqual(merged.at(-1), { alert: 'breach:F', severity: 'critical' });
});

test('alerts go to the log, Telegram and Sentry; the same key repeats only after its interval', async () => {
  const r = recorder();
  const alerts = createAlerts({
    log: r.log, fetch: r.fetch,
    env: { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-100', SENTRY_DSN: 'https://pub@o1.ingest.sentry.io/42', HEARTBEAT_URL: 'https://beat.example/k' },
  });
  const to = (host: string) => r.requests.filter((q) => q.url.includes(host));
  alerts.send('breach:F', 'critical', 'Funded account F reached its equity floor');
  alerts.send('breach:F', 'critical', 'Funded account F reached its equity floor');
  alerts.send('info-only', 'info', 'Every active funded account is restricted');
  await until(async () => to('telegram').length === 1, 5_000, 'the Telegram message');
  assert.deepEqual(r.logged, [['error', 'Funded account F reached its equity floor'], ['info', 'Every active funded account is restricted']]);
  const [telegram] = to('telegram');
  const [sentry, ...moreSentry] = to('sentry');
  assert.equal(moreSentry.length, 0, 'informational alerts do not go to Sentry; repeats go nowhere');
  assert.equal(telegram!.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.deepEqual(JSON.parse(telegram!.init.body as string), {
    chat_id: '-100', text: '[critical] Funded account F reached its equity floor\n[info] Every active funded account is restricted', disable_web_page_preview: true,
  }, 'alerts raised together go out as one message');

  assert.equal(sentry!.url, 'https://o1.ingest.sentry.io/api/42/envelope/');
  const headers = sentry!.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/x-sentry-envelope');
  assert.match(headers['x-sentry-auth']!, /^Sentry sentry_version=7, sentry_key=pub, /);
  const [head, item, event, end] = (sentry!.init.body as string).split('\n');
  assert.deepEqual([JSON.parse(item!), end], [{ type: 'event' }, '']);
  const e = JSON.parse(event!);
  assert.equal(JSON.parse(head!).event_id, e.event_id);
  assert.deepEqual([e.level, e.message.formatted, e.tags.alert], ['error', 'Funded account F reached its equity floor', 'breach:F']);

  const sentAt = Date.now();
  alerts.send('breach:F', 'critical', 'again', 0);
  alerts.heartbeat();
  alerts.heartbeat();
  await until(async () => to('telegram').length === 2, 10_000, 'the second Telegram message');
  assert.ok(Date.now() - sentAt >= 3_500, 'the next Telegram message waits its turn (4 s apart)');
  assert.deepEqual([to('sentry').length, to('beat.example').length, JSON.parse(to('telegram')[1]!.init.body as string).text], [2, 1, '[critical] again'],
    'a zero interval repeats; the heartbeat is throttled to one per 30 s');
});

test('Telegram rate limits: the message is sent again when Telegram says, and nothing is lost', async () => {
  const r = recorder();
  const posts: string[] = [];
  const limited = (async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(init.body as string).text);
    return posts.length === 1
      ? new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":1}}', { status: 429 })
      : new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const alerts = createAlerts({ log: r.log, fetch: limited, env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' } });
  alerts.send('a', 'critical', 'first');
  await until(async () => posts.length === 1, 5_000, 'the first post');
  alerts.send('b', 'critical', 'second'); // raised while rate-limited: joins the retry
  await until(async () => posts.length === 2, 5_000, 'the retry');
  assert.deepEqual(posts, ['[critical] first', '[critical] first\n[critical] second']);
  assert.ok(r.logged.some(([, t]) => t === 'Telegram rate-limited the alerts; sending them again'));
  assert.ok(!r.logged.some(([, t]) => t === 'Telegram rejected the alert'));
});

test('unconfigured channels: alerts are only logged, and the missing settings are named once', async () => {
  const r = recorder();
  const alerts = createAlerts({ log: r.log, fetch: r.fetch, env: {} });
  alerts.send('stale:SOL', 'warning', 'SOL prices are 25 s old');
  alerts.heartbeat();
  await settle();
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.logged.map(([, t]) => t), [
    'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: keeper alerts go to the log only',
    'HEARTBEAT_URL not set: no keeper heartbeat',
    'SENTRY_DSN not set: keeper alerts are not sent to Sentry',
    'SOL prices are 25 s old',
  ]);
  assert.throws(() => createAlerts({ log: r.log, env: { SENTRY_DSN: 'https://sentry.io/' } }), /SENTRY_DSN is not a Sentry DSN/);
});

test('a failing channel is logged without its URL (the Telegram URL carries the bot token)', async () => {
  const r = recorder();
  const failing = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
  const alerts = createAlerts({ log: r.log, fetch: failing, env: { TELEGRAM_BOT_TOKEN: 'secret-token', TELEGRAM_CHAT_ID: '1' } });
  alerts.send('k', 'warning', 'x');
  await until(async () => r.logged.some(([, t]) => t === 'Telegram rejected the alert'), 5_000, 'the rejection');
  assert.ok(r.logged.every(([, t]) => !t.includes('secret-token')));
});
