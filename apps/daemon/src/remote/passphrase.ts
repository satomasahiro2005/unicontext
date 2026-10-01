import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt parameters stored next to the hash, so they can be raised later without a migration. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export interface PassphraseHash extends ScryptParams {
  alg: 'scrypt';
  /** base64url */
  salt: string;
  /** base64url, 32 bytes */
  hash: string;
}

/** ~100 ms on a laptop; 64 MiB of memory per attempt makes offline guessing expensive. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

export const MIN_PASSPHRASE_LENGTH = 8;

function derive(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassphrase(
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<PassphraseHash> {
  const salt = randomBytes(16);
  const key = await derive(passphrase, salt, params);
  return {
    alg: 'scrypt',
    ...params,
    salt: salt.toString('base64url'),
    hash: key.toString('base64url'),
  };
}

export async function verifyPassphrase(
  passphrase: string,
  stored: PassphraseHash,
): Promise<boolean> {
  if (stored.alg !== 'scrypt') return false;
  const expected = Buffer.from(stored.hash, 'base64url');
  const key = await derive(passphrase, Buffer.from(stored.salt, 'base64url'), stored);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Why a new passphrase is rejected, or undefined when it is acceptable. */
export function passphraseProblem(passphrase: string): string | undefined {
  const p = passphrase.normalize('NFKC');
  if ([...p].length < MIN_PASSPHRASE_LENGTH)
    return `パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上にしてください`;
  if (new Set(p).size < 5) return '同じ文字の繰り返しが多すぎます';
  return undefined;
}
