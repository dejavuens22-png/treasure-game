const express = require("express");
const { db } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const defaultAvatar = {
  gender: "male",
  skin: "tan",
  face: "face_01",
  eyes: "brown",
  hairStyle: "short",
  hairColor: "black",
  top: "white_tank",
  bottom: "white_shorts",
  shoes: "white_sneakers",
  accessory: "none",
};

const getAuthUserId = (req) => req.user?.userId ?? req.user?.id;

/** slot 1–10 */
const AVATAR_PRICE_BY_SLOT = {
  1: 0,
  2: 0,
  3: 0,
  4: 100,
  5: 500,
  6: 1500,
  7: 2500,
  8: 6000,
  9: 10000,
  10: 15000,
};

function parseAvatarId(id) {
  if (typeof id !== "string") return null;
  const m = id.match(/^(male|female)_(\d{2})$/);
  if (!m) return null;
  const slot = parseInt(m[2], 10);
  if (slot < 1 || slot > 10) return null;
  return { gender: m[1], slot, fullId: id };
}

function normalizeOwned(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    if (typeof raw === "string") return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

async function getWalletTokens(userId) {
  const r = await db.query("SELECT wallet_tokens FROM users WHERE id = $1", [userId]);
  return r.rows[0]?.wallet_tokens ?? 0;
}

router.get("/avatar", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const result = await db.query(
      "SELECT avatar_json FROM users WHERE id = $1",
      [userId]
    );

    return res.json({
      avatar: result.rows[0]?.avatar_json || defaultAvatar,
    });
  } catch (err) {
    console.error("[GET /user/avatar] error:", err);
    return res.status(500).json({ message: "Avatar alinamadi." });
  }
});

router.post("/avatar", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    const { avatar } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    if (!avatar || typeof avatar !== "object") {
      return res.status(400).json({ message: "Gecersiz avatar verisi." });
    }

    const result = await db.query(
      `UPDATE users
       SET avatar_json = $1
       WHERE id = $2
       RETURNING avatar_json`,
      [avatar, userId]
    );

    return res.json({
      message: "Avatar kaydedildi.",
      avatar: result.rows[0]?.avatar_json || avatar,
    });
  } catch (err) {
    console.error("[POST /user/avatar] error:", err);
    return res.status(500).json({ message: "Avatar kaydedilemedi." });
  }
});

router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const result = await db.query(
      `SELECT username, wallet_tokens, gender, selected_avatar, owned_avatars
       FROM users WHERE id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    const rawG = row.gender;
    const gs = rawG == null ? "" : String(rawG).trim();
    const genderNormalized =
      gs === "" || gs === "null" || gs === "undefined" ? null : gs;
    const rawSel = row.selected_avatar;
    const ss = rawSel == null ? "" : String(rawSel).trim();
    const selectedNormalized =
      ss === "" || ss === "null" || ss === "undefined" ? null : ss;

    return res.json({
      username: row.username,
      wallet_tokens: row.wallet_tokens ?? 0,
      gender: genderNormalized,
      selected_avatar: selectedNormalized,
      owned_avatars: normalizeOwned(row.owned_avatars),
    });
  } catch (err) {
    console.error("[GET /user/profile] error:", err);
    return res.status(500).json({ message: "Profil alinamadi." });
  }
});

router.post("/gender", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const { gender } = req.body;
    if (gender !== "male" && gender !== "female") {
      return res.status(400).json({ message: "Gecersiz cinsiyet." });
    }

    const cur = await db.query(
      "SELECT gender, owned_avatars FROM users WHERE id = $1",
      [userId]
    );
    const existing = cur.rows[0];
    if (!existing) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    const eg = existing.gender;
    const egStr = eg == null ? "" : String(eg).trim();
    const genderAlreadySet = egStr !== "" && egStr !== "null" && egStr !== "undefined";
    if (genderAlreadySet) {
      return res.status(400).json({ message: "Cinsiyet zaten seçilmiş." });
    }

    const prefix = gender;
    const starter = [`${prefix}_01`, `${prefix}_02`, `${prefix}_03`];

    await db.query(
      `UPDATE users
       SET gender = $1,
           owned_avatars = $2::jsonb,
           selected_avatar = $3
       WHERE id = $4`,
      [gender, JSON.stringify(starter), `${prefix}_01`, userId]
    );

    return res.json({
      message: "Cinsiyet kaydedildi.",
      gender,
      owned_avatars: starter,
      selected_avatar: `${prefix}_01`,
    });
  } catch (err) {
    console.error("[POST /user/gender] error:", err);
    return res.status(500).json({ message: "Cinsiyet kaydedilemedi." });
  }
});

router.get("/avatars", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const result = await db.query(
      `SELECT gender, selected_avatar, owned_avatars FROM users WHERE id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    const gender = row.gender;
    if (gender == null || String(gender).trim() === "") {
      return res.status(400).json({ message: "Once cinsiyet seçilmeli." });
    }

    const prefix = gender === "female" ? "female" : "male";
    const owned = new Set(normalizeOwned(row.owned_avatars));
    const selected = row.selected_avatar;

    const list = [];
    for (let slot = 1; slot <= 10; slot += 1) {
      const id = `${prefix}_${String(slot).padStart(2, "0")}`;
      list.push({
        id,
        image: `${id}.png`,
        price: AVATAR_PRICE_BY_SLOT[slot],
        owned: owned.has(id),
        selected: selected === id,
      });
    }

    return res.json({ avatars: list });
  } catch (err) {
    console.error("[GET /user/avatars] error:", err);
    return res.status(500).json({ message: "Avatar listesi alinamadi." });
  }
});

router.post("/avatars/buy", authMiddleware, async (req, res) => {
  const client = await db.connect();
  try {
    const userId = getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const { avatarId } = req.body;
    const parsed = parseAvatarId(avatarId);
    if (!parsed) {
      return res.status(400).json({ message: "Gecersiz avatar." });
    }

    await client.query("BEGIN");

    const u = await client.query(
      `SELECT gender, wallet_tokens, owned_avatars
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    const row = u.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    if (row.gender == null || String(row.gender).trim() === "") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Once cinsiyet seçilmeli." });
    }

    if (parsed.gender !== row.gender) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Avatar cinsiyet ile uyumsuz." });
    }

    const owned = normalizeOwned(row.owned_avatars);
    if (owned.includes(avatarId)) {
      await client.query("ROLLBACK");
      return res.json({ message: "Zaten satin alindi.", avatarId, owned_avatars: owned });
    }

    const price = AVATAR_PRICE_BY_SLOT[parsed.slot];
    if (price === undefined) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Gecersiz avatar slot." });
    }

    if (price === 0) {
      const next = [...new Set([...owned, avatarId])];
      await client.query(`UPDATE users SET owned_avatars = $1::jsonb WHERE id = $2`, [
        JSON.stringify(next),
        userId,
      ]);
      await client.query("COMMIT");
      return res.json({ message: "Avatar eklendi.", owned_avatars: next });
    }

    const balance = row.wallet_tokens ?? 0;
    if (balance < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Yeterli token yok." });
    }

    const newBalance = balance - price;
    const nextOwned = [...new Set([...owned, avatarId])];
    const now = Date.now();

    await client.query(
      `UPDATE users
       SET wallet_tokens = $1,
           owned_avatars = $2::jsonb
       WHERE id = $3`,
      [newBalance, JSON.stringify(nextOwned), userId]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, treasure_id, amount, type, created_at)
       VALUES ($1, NULL, $2, $3, $4)`,
      [userId, -price, "avatar_purchase", now]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Satin alma basarili.",
      wallet_tokens: newBalance,
      owned_avatars: nextOwned,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /user/avatars/buy] error:", err);
    return res.status(500).json({ message: "Satin alma basarisiz." });
  } finally {
    client.release();
  }
});

router.post("/avatars/select", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Kullanici kimligi bulunamadi." });
    }

    const { avatarId } = req.body;
    const parsed = parseAvatarId(avatarId);
    if (!parsed) {
      return res.status(400).json({ message: "Gecersiz avatar." });
    }

    const result = await db.query(
      `SELECT gender, owned_avatars FROM users WHERE id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    if (parsed.gender !== row.gender) {
      return res.status(400).json({ message: "Avatar cinsiyet ile uyumsuz." });
    }

    const owned = normalizeOwned(row.owned_avatars);
    if (!owned.includes(avatarId)) {
      return res.status(400).json({ message: "Bu avatar sahip olunanlar arasinda degil." });
    }

    await db.query(`UPDATE users SET selected_avatar = $1 WHERE id = $2`, [avatarId, userId]);

    return res.json({ message: "Avatar secildi.", selected_avatar: avatarId });
  } catch (err) {
    console.error("[POST /user/avatars/select] error:", err);
    return res.status(500).json({ message: "Secim basarisiz." });
  }
});

module.exports = router;
