const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/game",
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      wallet_tokens INTEGER DEFAULT 0,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      last_active_at BIGINT,
      last_location_at BIGINT
    );
  `);
  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS avatar_json JSONB
  `);
  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS gender TEXT
  `);
  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS selected_avatar TEXT
  `);
  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS owned_avatars JSONB DEFAULT '[]'::jsonb
  `);
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at BIGINT
  `);
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_logout_at BIGINT
  `);
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS treasures (
      id SERIAL PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      type TEXT DEFAULT 'small',
      value INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at BIGINT NOT NULL,
      collected_by INTEGER REFERENCES users(id),
      collected_at BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      treasure_id INTEGER REFERENCES treasures(id),
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suspicious_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES admin_users(id),
      action TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      ip_address TEXT,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_last_active
    ON users(last_active_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_treasures_status
    ON treasures(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created
    ON wallet_transactions(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_suspicious_events_user_created
    ON suspicious_events(user_id, created_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token
    ON admin_sessions(token);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_logs_created
    ON admin_logs(created_at DESC);
  `);

  console.log("PostgreSQL tablolari hazir.");
};

module.exports = {
  db: pool,
  initDb,
};