import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

config({
  path: '.env.local',
});

const runMigrate = async () => {
  const requiredEnvVars = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Environment variable ${envVar} is not defined`);
    }
  }

  const pool = new Pool({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT!, 10),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 1, // Recommended for migrations
    ssl: process.env.DB_SSL_REQUIRED === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool);

  console.log('⏳ Running migrations...');

  const start = Date.now();
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  const end = Date.now();

  console.log('✅ Migrations completed in', end - start, 'ms');
  process.exit(0);
};

runMigrate().catch((err) => {
  console.error('❌ Migration failed');
  console.error(err);
  process.exit(1);
});
