import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/** Minimal JWS (compact) verification for `private_key_jwt` client assertions (RFC 7523). */

export interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

const ALGS: Record<string, { hash: string | null; kty: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  PS384: { hash: 'sha384', kty: 'RSA', pss: true },
  PS512: { hash: 'sha512', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', ec: true },
  ES384: { hash: 'sha384', kty: 'EC', ec: true },
  ES512: { hash: 'sha512', kty: 'EC', ec: true },
  EdDSA: { hash: null, kty: 'OKP' },
};

export const SUPPORTED_JWS_ALGS = Object.keys(ALGS);

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

export function decodeJwt(token: string): DecodedJwt | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [h, p, s] = parts as [string, string, string];
  try {
    return {
      header: decodePart(h),
      payload: decodePart(p),
      signingInput: `${h}.${p}`,
      signature: Buffer.from(s, 'base64url'),
    };
  } catch {
    return undefined;
  }
}

function keyFor(jwk: Jwk): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return undefined;
  }
}

/** Verify the signature of a decoded JWT against a JWK set. */
export function verifyJwtSignature(jwt: DecodedJwt, keys: readonly Jwk[]): boolean {
  const alg = typeof jwt.header.alg === 'string' ? jwt.header.alg : '';
  const spec = ALGS[alg];
  if (!spec) return false; // includes "none"
  const kid = typeof jwt.header.kid === 'string' ? jwt.header.kid : undefined;
  const candidates = keys.filter(
    (k) =>
      k.kty === spec.kty &&
      (kid === undefined || k.kid === kid) &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === alg),
  );
  const data = Buffer.from(jwt.signingInput);
  for (const jwk of candidates) {
    const key = keyFor(jwk);
    if (!key) continue;
    try {
      const ok = verify(
        spec.hash,
        data,
        spec.pss
          ? {
              key,
              padding: 6 /* RSA_PKCS1_PSS_PADDING */,
              saltLength: spec.hash === 'sha512' ? 64 : spec.hash === 'sha384' ? 48 : 32,
            }
          : spec.ec
            ? { key, dsaEncoding: 'ieee-p1363' }
            : key,
        jwt.signature,
      );
      if (ok) return true;
    } catch {
      // try the next key
    }
  }
  return false;
}
