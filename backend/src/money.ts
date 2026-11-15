import { badRequest } from './errors.js';

export function parseCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive integer number of cents`, { field });
  }

  return value;
}

export function centsFromDb(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`cents value out of safe range: ${value}`)
  return n;
}
