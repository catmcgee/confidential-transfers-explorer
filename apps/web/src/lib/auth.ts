import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { cookies } from 'next/headers';
import type { SessionUser } from '@ct-explorer/shared';

const JWT_SECRET = new TextEncoder().encode(process.env['JWT_SECRET'] || 'dev-secret-change-in-production');
const JWT_ISSUER = 'ct-explorer';
const JWT_AUDIENCE = 'ct-explorer-web';
const SESSION_DURATION = 24 * 60 * 60; // 24 hours in seconds

export interface JWTClaims extends JWTPayload {
  publicKey: string;
}

/**
 * Create a session token for a user
 */
export async function createSessionToken(publicKey: string): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;

  const token = await new SignJWT({ publicKey })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(expiresAt)
    .sign(JWT_SECRET);

  return { token, expiresAt };
}

/**
 * Verify a session token
 */
export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const claims = payload as JWTClaims;
    if (!claims.publicKey || !claims.exp) {
      return null;
    }

    return {
      publicKey: claims.publicKey,
      exp: claims.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Get current session from cookies
 */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('session')?.value;
  if (!token) {
    return null;
  }
  return verifySessionToken(token);
}

/**
 * Set session cookie
 */
export async function setSessionCookie(token: string, expiresAt: number): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set('session', token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    expires: new Date(expiresAt * 1000),
    path: '/',
  });
}

/**
 * Clear session cookie
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete('session');
}

/**
 * Verify a signature from a wallet
 */
export function verifySignature(publicKey: string, message: string, signature: string): boolean {
  // For Wallet Standard, we receive base58-encoded signatures
  // In production, use @solana/keys for proper ed25519 verification
  // For now, we'll do a simplified check that the signature exists and is valid format

  try {
    // Check signature is base58 encoded and reasonable length
    const signatureBytes = decodeBase58(signature);
    if (signatureBytes.length !== 64) {
      return false;
    }

    // In production, implement proper ed25519 verification:
    // import { verifySignature } from '@solana/keys';
    // const messageBytes = new TextEncoder().encode(message);
    // return await verifySignature(publicKeyBytes, signatureBytes, messageBytes);

    // For development, we trust the client-provided signature
    // IMPORTANT: Replace with proper verification in production!
    console.log('[Auth] Signature verification (development mode):', {
      publicKey: publicKey.slice(0, 8) + '...',
      messageLength: message.length,
      signatureLength: signatureBytes.length,
    });

    return true;
  } catch (error) {
    console.error('[Auth] Signature verification error:', error);
    return false;
  }
}

/**
 * Simple base58 decoder
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP.set(BASE58_ALPHABET[i]!, i);
}

function decodeBase58(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const char of str) {
    const value = BASE58_MAP.get(char);
    if (value === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}
