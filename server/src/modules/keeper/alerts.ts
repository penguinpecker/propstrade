// Operator alerts: every alert is logged; it also goes to Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) and, when
// not informational, to Sentry (SENTRY_DSN, envelope API over plain HTTP) when those are set. The keeper pings
// HEARTBEAT_URL after each completed tick so a stalled or leaderless keeper is noticed. All of them are optional.
// Telegram lets a bot post 20 messages a minute to a group: alerts raised together go out as one message, at most
// one message every 4 s, and a rate-limited message is sent again when Telegram says it may be.
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

export type AlertLevel = 'critical' | 'warning' | 'info';
/** The same alert key repeats at most this often. */
const REPEAT_MS = 30 * 60_000;
const HEARTBEAT_EVERY_MS = 30_000;
const TIMEOUT_MS = 10_000;
/** At most 15 Telegram messages a minute, under Telegram's 20 a minute per group. */
const TELEGRAM_EVERY_MS = 4_000;
/** Under Telegram's 4,096-character message limit. */
const TELEGRAM_MAX_CHARS = 4_000;

export interface AlertDeps {
  env: Record<string, string | undefined>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  fetch?: typeof fetch;
}

/** Sentry DSN "https://<key>@<host>[/<path>]/<project>" → envelope endpoint and key. */
function sentryTarget(dsn: string | undefined) {
  if (!dsn) return null;
  const url = new URL(dsn);
  const path = url.pathname.split('/').filter(Boolean);
  const project = path.pop();
  if (!url.username || !project) throw new Error('SENTRY_DSN is not a Sentry DSN');
  return { endpoint: `${url.protocol}//${url.host}/${[...path, 'api', project, 'envelope'].join('/')}/`, key: url.username };
}

export function createAlerts(d: AlertDeps) {
  const http = d.fetch ?? fetch;
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat, HEARTBEAT_URL: heartbeatUrl } = d.env;
  const sentry = sentryTarget(d.env.SENTRY_DSN || undefined);
  if (!token || !chat) d.log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: keeper alerts go to the log only');
  if (!heartbeatUrl) d.log.warn('HEARTBEAT_URL not set: no keeper heartbeat');
  if (!sentry) d.log.warn('SENTRY_DSN not set: keeper alerts are not sent to Sentry');
  const sentAt = new Map<string, number>();
  let lastHeartbeat = 0;

  /** POSTs and checks the status; failures are logged without the URL (the Telegram URL carries the bot token). */
  const post = (what: string, url: string, init: RequestInit) => {
    void http(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), ...init })
      .then((res) => (res.ok ? undefined : d.log.warn({ status: res.status }, `${what} rejected the alert`)))
      .catch((err: unknown) => d.log.warn({ reason: (err as Error).message }, `${what} unreachable`));
  };

  // Telegram outbox: lines waiting to be sent, flushed as one message (one at a time) no sooner than `nextTelegramAt`.
  const outbox: string[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let sending = false;
  let nextTelegramAt = 0;
  const scheduleTelegram = () => {
    if (flushTimer || sending) return;
    flushTimer = setTimeout(() => void flushTelegram(), Math.max(0, nextTelegramAt - Date.now())).unref();
  };
  async function flushTelegram() {
    flushTimer = undefined;
    sending = true;
    let count = 0;
    for (let size = 0; count < outbox.length && (count === 0 || size + outbox[count]!.length < TELEGRAM_MAX_CHARS); count++) size += outbox[count]!.length + 1;
    nextTelegramAt = Date.now() + TELEGRAM_EVERY_MS;
    const res = await http(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: outbox.slice(0, count).join('\n'), disable_web_page_preview: true }),
    }).catch((err: unknown) => err as Error);
    if (res instanceof Response && res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      const seconds = body.parameters?.retry_after ?? TELEGRAM_EVERY_MS / 1000;
      d.log.warn({ retryAfter: seconds }, 'Telegram rate-limited the alerts; sending them again');
      nextTelegramAt = Date.now() + seconds * 1000;
    } else {
      outbox.splice(0, count);
      if (res instanceof Error) d.log.warn({ reason: res.message }, 'Telegram unreachable');
      else if (!res.ok) d.log.warn({ status: res.status }, 'Telegram rejected the alert');
    }
    sending = false;
    if (outbox.length) scheduleTelegram();
  }

  return {
    /** Raises `text` under `key` unless the same key was raised within `repeatMs`. Delivery is in the background. */
    send(key: string, level: AlertLevel, text: string, repeatMs = REPEAT_MS): void {
      const now = Date.now();
      if (now - (sentAt.get(key) ?? -Infinity) < repeatMs) return;
      sentAt.set(key, now);
      // `severity`, not `level`: pino writes its own numeric level first, and JSON readers keep the last duplicate key.
      (level === 'critical' ? d.log.error : level === 'warning' ? d.log.warn : d.log.info).call(d.log, { alert: key, severity: level }, text);
      if (token && chat) {
        outbox.push(`[${level}] ${text}`.slice(0, TELEGRAM_MAX_CHARS));
        scheduleTelegram();
      }
      if (sentry && level !== 'info') {
        const eventId = randomUUID().replaceAll('-', '');
        const event = {
          event_id: eventId, timestamp: now / 1000, level: level === 'critical' ? 'error' : 'warning', platform: 'node', logger: 'keeper',
          message: { formatted: text }, tags: { alert: key },
        };
        post('Sentry', sentry.endpoint, {
          headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${sentry.key}, sentry_client=props-keeper/1.0` },
          body: `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
        });
      }
    },
    /** Pings HEARTBEAT_URL, at most every 30 s. */
    heartbeat(): void {
      if (!heartbeatUrl || Date.now() - lastHeartbeat < HEARTBEAT_EVERY_MS) return;
      lastHeartbeat = Date.now();
      post('Heartbeat', heartbeatUrl, {});
    },
  };
}

export type Alerts = ReturnType<typeof createAlerts>;
