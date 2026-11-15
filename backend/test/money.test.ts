// AI made
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { centsFromDb, parseCents } from '../src/money.js';

describe('parseCents', () => {
  it('accepts positive integers', () => {
    expect(parseCents(1, 'x')).toBe(1);
    expect(parseCents(1050, 'x')).toBe(1050);
    expect(parseCents(Number.MAX_SAFE_INTEGER, 'x')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['a fraction', 10.5],
    ['a numeric string', '100'],
    ['a decimal string', '10.50'],
    ['above 2^53', 2 ** 53],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined', undefined],
    ['an object', { cents: 100 }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCents(value, 'amount_cents')).toThrow(ApiError);
  });
});

describe('centsFromDb', () => {
  it('converts bigint strings from pg', () => {
    expect(centsFromDb('10000')).toBe(10000);
  });

  it('refuses values a JS number cannot hold exactly', () => {
    expect(() => centsFromDb('9223372036854775807')).toThrow();
  });
});
