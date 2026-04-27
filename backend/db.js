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
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      last_active_at BIGINT,
      last_location_at BIGINT
    );
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

  console.log("PostgreSQL tablolari hazir.");
};

module.exports = {
  db: pool,
  initDb,
};