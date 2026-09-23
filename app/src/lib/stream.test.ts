import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@props/shared';
import { openStream, STALE_AFTER_MS, type StreamStatus } from './stream';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly init: EventSourceInit) { FakeEventSource.instances.push(this); }
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }
  send(data: string) { this.onmessage?.({ data }); }
  error() { this.onerror?.(); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const latest = () => FakeEventSource.instances.at(-1)!;
let statuses: StreamStatus[];
let events: StreamEvent[];
let close: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
  statuses = [];
  events = [];
  close = openStream('https://api.test/v1/stream', e => events.push(e), s => statuses.push(s));
});
afterEach(() => { close(); vi.useRealTimers(); });

describe('openStream', () => {
  it('opens with credentials and reports connected', () => {
    expect(latest().url).toBe('https://api.test/v1/stream');
    expect(latest().init).toEqual({ withCredentials: true });
    latest().open();
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('delivers contract events and skips unparseable ones', () => {
    latest().open();
    latest().send('{"type":"heartbeat","ts":1}');
    latest().send('not json');
    expect(events).toEqual([{ type: 'heartbeat', ts: 1 }]);
  });

  it('backs off, reports offline after repeated failures, and recovers', () => {
    latest().error();
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2); // retried after 1 s
    latest().error();
    vi.advanceTimersByTime(2000); // then 2 s
    latest().error();
    expect(statuses.at(-1)).toBe('offline');
    vi.advanceTimersByTime(4000); // then 4 s
    expect(FakeEventSource.instances).toHaveLength(4);
    latest().open();
    expect(statuses.at(-1)).toBe('connected');
    latest().error();
    expect(statuses.at(-1)).toBe('reconnecting'); // failure count reset by the successful open
  });

  it('treats a silent stream as dropped', () => {
    latest().open();
    vi.advanceTimersByTime(STALE_AFTER_MS - 1000);
    latest().send('{"type":"heartbeat","ts":2}');
    vi.advanceTimersByTime(STALE_AFTER_MS - 1000);
    expect(statuses.at(-1)).toBe('connected');
    vi.advanceTimersByTime(10_000);
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(FakeEventSource.instances[0]!.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('retries a stream that never leaves CONNECTING', () => {
    vi.advanceTimersByTime(STALE_AFTER_MS + 5_000); // no open, no error: the server never answered
    expect(FakeEventSource.instances[0]!.readyState).toBe(FakeEventSource.CLOSED);
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('stops everything when closed', () => {
    latest().error();
    close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
