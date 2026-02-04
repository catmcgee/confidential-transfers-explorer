import { z } from 'zod';
import { TRACKED_CT_TYPES } from './constants.js';

// Solana pubkey validation (base58, 32-44 chars)
export const pubkeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address');

// Transaction signature validation (base58, 87-88 chars typically)
export const signatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'Invalid transaction signature');

// Pagination params
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().optional(),
});

// All valid CT type filters
const ctTypeFilter = z.enum(['all', ...TRACKED_CT_TYPES] as [string, ...string[]]).default('all');

// Feed query params
export const feedQuerySchema = paginationSchema.extend({
  type: ctTypeFilter,
});

// Address query params
export const addressQuerySchema = paginationSchema.extend({
  type: ctTypeFilter,
});

// Login request schema
export const loginRequestSchema = z.object({
  publicKey: pubkeySchema,
  signature: z.string().min(1, 'Signature required'),
  message: z.string().min(1, 'Message required'),
});

// Search query
export const searchQuerySchema = z.object({
  q: z.string().min(1).max(100),
});

// API response wrapper
export function apiResponse<T>(data: T) {
  return { success: true as const, data };
}

export function apiError(error: string, code?: string) {
  return { success: false as const, error, code };
}

export type ApiResponse<T> = ReturnType<typeof apiResponse<T>> | ReturnType<typeof apiError>;
