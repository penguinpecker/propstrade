import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@props/shared';

/** `connected` also means fresh: an event (at least a heartbeat) arrived within STALE_AFTER_MS. */
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** Spec §4.1 stale threshold: a stream silent for longer than this is treated as dropped. */
export const STALE_AFTER_MS = 20_000;
/** After this many consecutive failures the footer says "offline" (retries continue in the background). */
export const OFFLINE_AFTER_FAILURES = 3;
const MAX_BACKOFF_MS = 30_000;

export const backoffMs = (failures: number) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));

/**
 * Opens the server-sent event stream and keeps it open: reconnects with exponential backoff after errors,
 * after STALE_AFTER_MS of silence (also a connection that never opens), and as soon as the browser comes back
 * online. Returns a close function.
 */
export function openStream(url: string, onEvent: (event: StreamEvent) => void, onStatus: (status: StreamStatus) => void): () => void {
  let source: EventSource | null = null;
  let failures = 0;
  let lastEventAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const online = () => globalThis.navigator?.onLine !== false;

  function connect() {
    clearTimeout(retryTimer);
    source?.close();
    source = new EventSource(url, { withCredentials: true });
    lastEventAt = Date.now();
    source.onopen = () => {
      failures = 0;
      lastEventAt = Date.now();
      onStatus('connected');
    };
    source.onmessage = message => {
      lastEventAt = Date.now();
      let event: StreamEvent;
      try {
        event = JSON.parse(message.data) as StreamEvent;
      } catch {
        return; // not a contract event; the stream itself is still alive
      }
      onEvent(event);
    };
    source.onerror = fail;
  }

  function fail() {
    source?.close();
    source = null;
    failures += 1;
    onStatus(!online() || failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, backoffMs(failures));
  }

  const watchdog = setInterval(() => {
    if (source && Date.now() - lastEventAt > STALE_AFTER_MS) fail();
  }, 5_000);
  const handleOnline = () => { failures = 0; connect(); };
  const handleOffline = () => { if (source) fail(); };
  globalThis.addEventListener?.('online', handleOnline);
  globalThis.addEventListener?.('offline', handleOffline);

  onStatus('connecting');
  connect();

  return () => {
    source?.close();
    clearTimeout(retryTimer);
    clearInterval(watchdog);
    globalThis.removeEventListener?.('online', handleOnline);
    globalThis.removeEventListener?.('offline', handleOffline);
  };
}

/** Live stream state for the app; reopens when `sessionKey` changes so the server re-reads the session cookie. */
export function useStream(url: string, sessionKey: string, onEvent: (event: StreamEvent) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => openStream(url, event => handler.current(event), setStatus), [url, sessionKey]);
  return status;
}
