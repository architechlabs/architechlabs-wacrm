import { beforeEach, describe, it, expect, vi } from 'vitest';

const dns = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock('node:dns/promises', () => dns);

import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of [
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12::34',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  beforeEach(() => {
    dns.resolve4.mockRejectedValue(new Error('no A records'));
    dns.resolve6.mockRejectedValue(new Error('no AAAA records'));
  });

  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(
      await isDeliverableUrl('https://169.254.169.254/latest/meta-data')
    ).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });

  it('allows a hostname when every resolved address is public', async () => {
    dns.resolve4.mockResolvedValue(['93.184.216.34']);
    dns.resolve6.mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);

    expect(await isDeliverableUrl('https://example.com/hook')).toBe(true);
  });

  it('rejects a hostname when any resolved address is private', async () => {
    dns.resolve4.mockResolvedValue(['93.184.216.34', '127.0.0.1']);

    expect(await isDeliverableUrl('https://example.com/hook')).toBe(false);
  });

  it('allows a hostname when one address family resolves publicly', async () => {
    dns.resolve4.mockResolvedValue(['1.1.1.1']);

    expect(await isDeliverableUrl('https://example.com/hook')).toBe(true);
  });

  it('rejects a hostname when neither address family resolves', async () => {
    expect(await isDeliverableUrl('https://does-not-exist.invalid/hook')).toBe(
      false
    );
  });
});
