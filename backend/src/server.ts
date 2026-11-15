import { createApp } from "./app.js";
import { createPool } from "./db.js";

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

const server = createApp({ pool, color, version }).listen(port, '0.0.0.0', () => {
  console.log(`[${color}] ${version} listening on port ${port}`);
})

function shutdown(signal:string) {
  console.log(`[${color}] ${signal}: shutting off`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));