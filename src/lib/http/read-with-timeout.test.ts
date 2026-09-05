import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWithTimeout } from './read-with-timeout';

afterEach(() => vi.useRealTimers());

describe('readWithTimeout', () => {
  it('returns successful reads and clears the watchdog', async () => {
    vi.useFakeTimers();
    await expect(readWithTimeout(async () => 'saved')).resolves.toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a hung auth-lock/read even if the underlying task ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = readWithTimeout(s => {
      signal = s;
      return new Promise<never>(() => {});
    });
    const assertion = expect(result).rejects.toThrow('Loading timed out');
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels obsolete reads on navigation and never retries', async () => {
    const controller = new AbortController();
    const read = vi.fn(() => new Promise<never>(() => {}));
    const result = readWithTimeout(read, controller.signal);
    const assertion = expect(result).rejects.toThrow('Read cancelled');
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(read).toHaveBeenCalledOnce();
  });
  it('does not start an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 'old account');
    await expect(readWithTimeout(read, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('ignores a late response and leaves the next account read independent', async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const first = readWithTimeout(() => new Promise<string>(r => { resolve = r; }));
    const assertion = expect(first).rejects.toThrow('Loading timed out');
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    await expect(readWithTimeout(async () => 'new account')).resolves.toBe('new account');
    resolve('old account');
  });
});
