import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './encryption';
import { resolveSavedCredentials } from './saved-credentials';

describe('workspace credential persistence', () => {
  const saved = { access_token: encrypt('test-access'), verify_token: encrypt('test-verify') };

  it.each([{}, { access_token: '', verify_token: '' }, { access_token: null, verify_token: null }])('preserves both saved ciphertexts when inputs are blank: %j', input => {
    const result = resolveSavedCredentials(input, saved);
    expect(result.accessToken).toBe('test-access');
    expect(result.encryptedAccessToken).toBe(saved.access_token);
    expect(result.encryptedVerifyToken).toBe(saved.verify_token);
  });
  it('replaces only the explicitly entered secret', () => {
    const result = resolveSavedCredentials({ access_token: 'new-test-access' }, saved);
    expect(decrypt(result.encryptedAccessToken)).toBe('new-test-access');
    expect(result.encryptedVerifyToken).toBe(saved.verify_token);
  });
  it('can replace only the verify token while keeping the access token', () => {
    const result = resolveSavedCredentials({ verify_token: 'new-test-verify' }, saved);
    expect(result.encryptedAccessToken).toBe(saved.access_token);
    expect(decrypt(result.encryptedVerifyToken!)).toBe('new-test-verify');
  });
  it('requires credentials for first setup, not for later logins', () => {
    expect(() => resolveSavedCredentials({}, null)).toThrow('initial setup');
    expect(() => resolveSavedCredentials({}, saved)).not.toThrow();
  });
  it('does not silently replace an unreadable saved access token', () => {
    expect(() => resolveSavedCredentials({}, { access_token: 'corrupt' })).toThrow('Nothing was changed');
  });
});
