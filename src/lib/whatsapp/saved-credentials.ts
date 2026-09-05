import { decrypt, encrypt } from './encryption';

export class SavedCredentialsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SavedCredentialsError';
  }
}

/** Blank secret inputs mean keep, not erase. Never return these to a browser. */
export function resolveSavedCredentials(
  input: { access_token?: unknown; verify_token?: unknown },
  existing: { access_token: string; verify_token?: string | null } | null,
) {
  for (const value of [input.access_token, input.verify_token]) {
    if (value != null && typeof value !== 'string') {
      throw new SavedCredentialsError('Credential fields must be strings', 400);
    }
  }
  const newAccess = typeof input.access_token === 'string' ? input.access_token.trim() : '';
  const newVerify = typeof input.verify_token === 'string' ? input.verify_token.trim() : '';
  if (!newAccess && !existing?.access_token) {
    throw new SavedCredentialsError('Access Token is required for initial setup', 400);
  }
  try {
    return {
      accessToken: newAccess || decrypt(existing!.access_token),
      // Keep ciphertext byte-for-byte unless the administrator replaces it.
      encryptedAccessToken: newAccess ? encrypt(newAccess) : existing!.access_token,
      encryptedVerifyToken: newVerify ? encrypt(newVerify) : existing?.verify_token ?? null,
    };
  } catch {
    throw new SavedCredentialsError(
      'Saved credentials could not be read securely. Ask the administrator to check the server encryption configuration. Nothing was changed.',
      503,
    );
  }
}
