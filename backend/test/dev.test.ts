// AI MADE
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { FakeGateway } from '../src/gateway.js';
import { TEST_DATABASE_URL } from './env.js';

const pool = createPool(TEST_DATABASE_URL);
afterAll(() => pool.end());

describe('dev tools (/api/dev)', () => {
  it('does not exist unless enabled', async () => {
    const app = createApp({ pool, color: 'test', version: 'test', gateway: new FakeGateway() });
    const res = await request(app).get('/api/dev/gateway');
    expect(res.status).toBe(404);
  });

  it('reports the fake gateway and queues failures for its next calls', async () => {
    const gateway = new FakeGateway();
    const app = createApp({ pool, color: 'test', version: 'test', gateway, devGateway: gateway });

    expect((await request(app).get('/api/dev/gateway')).body).toEqual({ charges: 0, refunds: 0, queued: [] });

    const res = await request(app).post('/api/dev/gateway/fail-next').send({ mode: 'lost-response' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toEqual(['lost-response']);
  });

  it('rejects an unknown failure mode', async () => {
    const gateway = new FakeGateway();
    const app = createApp({ pool, color: 'test', version: 'test', gateway, devGateway: gateway });
    const res = await request(app).post('/api/dev/gateway/fail-next').send({ mode: 'explode' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field: 'mode' });
  });
});
