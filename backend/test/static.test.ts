import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { FakeGateway } from '../src/gateway.js';
import { TEST_DATABASE_URL } from './env.js';

// A stand-in for the built frontend.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-static-'));
fs.mkdirSync(path.join(dir, 'assets'));
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');

const pool = createPool(TEST_DATABASE_URL);
const app = createApp({ pool, color: 'test', version: 'test', gateway: new FakeGateway(), staticDir: dir });

afterAll(async () => {
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('serving the frontend', () => {
  it('serves the app shell at / without caching it', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>shell</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves the app shell for client-side routes like /orders/<id>', async () => {
    const res = await request(app).get('/orders/7dc2ad97-3dd6-4709-94e0-f783c0e79dbc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('serves fingerprinted assets as immutable', async () => {
    const res = await request(app).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('still answers unknown /api routes with JSON 404, not the app shell', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('keeps /healthz working', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
