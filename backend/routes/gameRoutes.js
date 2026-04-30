const express = require("express");
const { db } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { distanceMeters } = require("../utils/geo");
const { generateTreasureReward } = require("../utils/treasure");

const router = express.Router();

const ACTIVE_WINDOW_MS = 60 * 1000;
const TREASURE_SPAWN_COOLDOWN_MS = 30 * 1000;
const COLLECT_DISTANCE_METERS = 40;
const TREASURE_SPAWN_DISTANCE_METERS = 1;
const RATE_LIMIT_LOCATION_MS = 3000;
const RATE_LIMIT_COLLECT_MS = 5000;
const FAST_JUMP_WINDOW_MS = 3000;
const FAST_JUMP_DISTANCE_METERS = 100;
const LONG_JUMP_WINDOW_MS = 10000;
const LONG_JUMP_DISTANCE_METERS = 500;
const SUSPICIOUS_SPEED_KMH = 80;

let lastSpawnAttemptAt = 0;
const lastLocationRequestByUser = new Map();
const lastCollectRequestByUser = new Map();

const isValidCoordinates = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

const getAuthUserId = (req) => req.user?.userId ?? req.user?.id;

const nowMs = () => Date.now();

const tryConsumeUserRateLimit = (store, userId, intervalMs) => {
  const now = nowMs();
  const last = store.get(userId) ?? 0;
  if (now - last < intervalMs) {
    return false;
  }
  store.set(userId, now);
  return true;
};

const logSuspiciousEvent = async (userId, type, message, metadata = {}) => {
  try {
    await db.query(
      `INSERT INTO suspicious_events (user_id, type, message, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [userId ?? null, type, message, JSON.stringify(metadata), nowMs()]
    );
  } catch (err) {
    console.error("[suspicious_events] log error:", err);
  }
};

const offsetByMeters = (lat, lng, meters) => {
  const angle = Math.random() * 2 * Math.PI;
  const radius = Math.random() * meters;
  const dx = radius * Math.cos(angle);
  const dy = radius * Math.sin(angle);

  return {
    lat: lat + dy / 111320,
    lng: lng + dx / (111320 * Math.cos((lat * Math.PI) / 180) || 1),
  };
};

const maybeSpawnTreasure = async (preferredUserId) => {
  const now = Date.now();
  const activeSince = now - ACTIVE_WINDOW_MS;

  const existing = await db.query(
    "SELECT id FROM treasures WHERE status = 'active' LIMIT 1"
  );

  if (existing.rows.length > 0) {
    console.log("[spawn] reason=active_treasure_exists");
    return { spawned: false, reason: "active_treasure_exists" };
  }

  if (now - lastSpawnAttemptAt < TREASURE_SPAWN_COOLDOWN_MS) {
    console.log("[spawn] reason=cooldown");
    return { spawned: false, reason: "cooldown" };
  }

  lastSpawnAttemptAt = now;

  const activeUsersResult = await db.query(
    "SELECT id, lat, lng FROM users WHERE last_active_at >= $1 AND lat IS NOT NULL AND lng IS NOT NULL",
    [activeSince]
  );

  const activeUsers = activeUsersResult.rows;

  if (activeUsers.length < 2) {
    console.log("[spawn] reason=not_enough_active_players");
    return { spawned: false, reason: "not_enough_active_players" };
  }

  const preferredPlayer = activeUsers.find((player) => player.id === preferredUserId);
  const targetPlayer =
    preferredPlayer || activeUsers[Math.floor(Math.random() * activeUsers.length)];

  const spawnPoint = offsetByMeters(
    Number(targetPlayer.lat),
    Number(targetPlayer.lng),
    TREASURE_SPAWN_DISTANCE_METERS
  );

  const reward = generateTreasureReward();

  const insertResult = await db.query(
    `INSERT INTO treasures (lat, lng, type, value, status, created_at)
     VALUES ($1, $2, $3, $4, 'active', $5)
     RETURNING id, lat, lng, type, value`,
    [spawnPoint.lat, spawnPoint.lng, reward.type, reward.value, now]
  );

  return {
    spawned: true,
    reason: "spawned",
    treasure: insertResult.rows[0],
  };
};

router.post("/location", authMiddleware, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const now = nowMs();
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    if (!tryConsumeUserRateLimit(lastLocationRequestByUser, userId, RATE_LIMIT_LOCATION_MS)) {
      return res.status(429).json({ message: "Cok hizli istek gonderiyorsun." });
    }

    if (!isValidCoordinates(lat, lng)) {
      return res.status(400).json({ message: "Gecersiz lat/lng degeri." });
    }

    const userResult = await db.query(
      "SELECT id, lat, lng, last_location_at FROM users WHERE id = $1",
      [userId]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    if (
      user.lat !== null &&
      user.lng !== null &&
      user.last_location_at &&
      now > Number(user.last_location_at)
    ) {
      const meters = distanceMeters(
        Number(user.lat),
        Number(user.lng),
        lat,
        lng
      );
      const hours = (now - Number(user.last_location_at)) / (1000 * 60 * 60);
      const deltaMs = now - Number(user.last_location_at);
      const speedKmh = hours > 0 ? meters / 1000 / hours : 0;

      if (
        (deltaMs <= FAST_JUMP_WINDOW_MS && meters > FAST_JUMP_DISTANCE_METERS) ||
        (deltaMs < LONG_JUMP_WINDOW_MS && meters > LONG_JUMP_DISTANCE_METERS)
      ) {
        await logSuspiciousEvent(
          userId,
          "impossible_speed",
          "Imkansiz hiz veya zip tespit edildi, konum reddedildi.",
          { meters: Number(meters.toFixed(2)), deltaMs, speedKmh: Number(speedKmh.toFixed(2)) }
        );
        return res.status(400).json({
          message: "Supheli hiz tespit edildi, konum reddedildi.",
        });
      }

      if (speedKmh > SUSPICIOUS_SPEED_KMH && meters >= 120) {
        await logSuspiciousEvent(userId, "impossible_speed", "Yuksek hizli hareket tespit edildi.", {
          meters: Number(meters.toFixed(2)),
          deltaMs,
          speedKmh: Number(speedKmh.toFixed(2)),
        });
      }
    }

    const updateResult = await db.query(
      `UPDATE users
       SET lat = $1, lng = $2, last_active_at = $3, last_location_at = $4
       WHERE id = $5`,
      [lat, lng, now, now, userId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    const spawnResult = await maybeSpawnTreasure(userId);

    return res.json({
      message: "Konum guncellendi.",
      spawn: spawnResult,
    });
  } catch (err) {
    console.error("[/game/location] error:", err);
    return res.status(500).json({ message: "Konum guncellenemedi." });
  }
});

router.get("/treasure", authMiddleware, async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT id, lat, lng, type, value, status, created_at
       FROM treasures
       WHERE status = 'active'
       LIMIT 1`
    );

    return res.json({
      activeTreasure: result.rows[0] || null,
    });
  } catch (err) {
    console.error("[/game/treasure] error:", err);
    return res.status(500).json({ message: "Hazine bilgisi alinamadi." });
  }
});

router.post("/treasure/collect", authMiddleware, async (req, res) => {
  const client = await db.connect();

  try {
    const now = nowMs();
    const userId = getAuthUserId(req);

    if (!userId) {
      client.release();
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    if (!tryConsumeUserRateLimit(lastCollectRequestByUser, userId, RATE_LIMIT_COLLECT_MS)) {
      await logSuspiciousEvent(userId, "rate_limit_collect", "Collect endpoint rate limit asildi.");
      client.release();
      return res.status(429).json({ message: "Cok hizli istek gonderiyorsun." });
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      "SELECT id, lat, lng FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );

    const user = userResult.rows[0];

    if (!user || user.lat === null || user.lng === null) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(400).json({
        message: "Treasure toplamak icin gecerli konum gerekli.",
      });
    }

    const treasureResult = await client.query(
      `SELECT id, lat, lng, type, value
       FROM treasures
       WHERE status = 'active'
       LIMIT 1
       FOR UPDATE`
    );

    const treasure = treasureResult.rows[0];

    if (!treasure) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ message: "Aktif hazine yok." });
    }

    const distance = distanceMeters(
      Number(user.lat),
      Number(user.lng),
      Number(treasure.lat),
      Number(treasure.lng)
    );

    if (distance > COLLECT_DISTANCE_METERS) {
      await logSuspiciousEvent(userId, "collect_too_far", "Oyuncu hazineye uzak collect denedi.", {
        treasureId: treasure.id,
        distanceMeters: Number(distance.toFixed(2)),
        requiredMeters: COLLECT_DISTANCE_METERS,
      });
      await client.query("ROLLBACK");
      client.release();
      return res.status(400).json({
        message: "Hazineye yeterince yakin degilsin.",
        distanceMeters: Number(distance.toFixed(2)),
        requiredMeters: COLLECT_DISTANCE_METERS,
      });
    }

    const updateTreasure = await client.query(
      `UPDATE treasures
       SET status = 'collected', collected_by = $1, collected_at = $2
       WHERE id = $3 AND status = 'active'`,
      [userId, now, treasure.id]
    );

    if (updateTreasure.rowCount === 0) {
      await logSuspiciousEvent(userId, "duplicate_collect", "Ayni hazine ikinci kez collect edilmeye calisildi.", {
        treasureId: treasure.id,
      });
      await client.query("ROLLBACK");
      client.release();
      return res.status(409).json({
        message: "Hazine baska oyuncu tarafindan toplandi.",
      });
    }

    const walletUpdateResult = await client.query(
      `UPDATE users 
       SET wallet_tokens = wallet_tokens + $1 
       WHERE id = $2
       RETURNING wallet_tokens`,
      [treasure.value, userId]
    );

    if (walletUpdateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    await client.query(
      `INSERT INTO wallet_transactions
       (user_id, treasure_id, amount, type, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, treasure.id, treasure.value, "treasure_collect", now]
    );

    await client.query("COMMIT");
    client.release();

    const spawnResult = await maybeSpawnTreasure(userId);
    const nextTreasure = spawnResult?.spawned ? spawnResult.treasure : null;

    return res.json({
      message: "Hazine toplandi!",
      reward: treasure.value,
      treasureType: treasure.type,
      newBalance: walletUpdateResult.rows[0]?.wallet_tokens ?? null,
      nextTreasure,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();

    console.error("[/game/treasure/collect] error:", err);
    return res.status(500).json({ message: "Hazine toplanamadi." });
  }
});

module.exports = router;