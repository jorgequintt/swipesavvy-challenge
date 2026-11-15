// AI made
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, setupTestApp } from './helpers.js';

const { pool, app } = setupTestApp();

beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('POST /api/orders', () => {
  it('creates an open order with the full amount outstanding', async () => {
    const res = await request(app).post('/api/orders').send({ total_cents: 10000 });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/orders/${res.body.id}`);
    expect(res.body).toMatchObject({
      currency: 'USD',
      total_cents: 10000,
      paid_cents: 0,
      outstanding_cents: 10000,
      status: 'open',
      payments: [],
      refunds: [],
    });
  });

  it('accepts an explicit currency', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ total_cents: 500, currency: 'EUR' });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe('EUR');
  });

  it.each([
    ['missing', {}],
    ['zero', { total_cents: 0 }],
    ['negative', { total_cents: -1 }],
    ['a float', { total_cents: 10.5 }],
    ['a string', { total_cents: '100' }],
    ['unsafe', { total_cents: 2 ** 60 }],
  ])('rejects a total that is %s', async (_label, body) => {
    const res = await request(app).post('/api/orders').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { field: 'total_cents' },
    });
  });

  it('rejects a bad currency', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ total_cents: 100, currency: 'usd' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field: 'currency' });
  });

  it('rejects a body that is not JSON', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Content-Type', 'application/json')
      .send('{"total_cents": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('GET /api/orders/:id', () => {
  it('returns an existing order', async () => {
    const created = await request(app).post('/api/orders').send({ total_cents: 2500 });
    const res = await request(app).get(`/api/orders/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  it('404s for an unknown id', async () => {
    const res = await request(app).get(
      '/api/orders/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s (not 500s) for an id that is not a uuid', async () => {
    const res = await request(app).get('/api/orders/not-a-uuid');
    expect(res.status).toBe(404);
  });
});

describe('the rest of the API', () => {
  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports healthy when the database is reachable', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, color: 'test' });
  });
});
