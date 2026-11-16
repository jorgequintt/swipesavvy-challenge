import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { FakeGateway } from "./gateway.js";

function requireEnv(name: string) {
  const value = process.env[name];
  if(!value) {
    console.error('Env variable by name ' + name + ' not set.')
    process.exit(1);
  }
  return value;
}

const color = requireEnv('SERVER_COLOR');
const pool = createPool(requireEnv('DATABASE_URL'));
const version = process.env.APP_VERSION ?? 'dev';
const port = Number(process.env.PORT ?? 3000);

const gateway = new FakeGateway(Number(process.env.GATEWAY_LATENCY_MS ?? 300));
// Set in the Docker image, where the built frontend sits next to the server.
// Unset in local dev: Vite serves the UI and proxies /api here.
const staticDir = process.env.STATIC_DIR;

// Test tools (inject gateway failures from the UI). Never enable in production.
const devGateway = process.env.DEV_TOOLS === '1' ? gateway : undefined;

const server = createApp({ pool, color, version, gateway, staticDir, devGateway }).listen(port, '0.0.0.0', () => {
  console.log(`[${color}] ${version} listening on port ${port}${devGateway ? ' (DEV_TOOLS on)' : ''}`);
})

function shutdown(signal:string) {
  console.log(`[${color}] ${signal}: shutting off`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));