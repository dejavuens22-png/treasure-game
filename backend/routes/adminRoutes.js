const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { db } = require("../db");

const router = express.Router();

const ADMIN_COOKIE = "admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const fmtTime = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString("tr-TR");
};

const getIp = (req) =>
  (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
  req.ip ||
  "unknown";

const page = (title, body, flash = "") => `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#0f172a; color:#e2e8f0; }
    .wrap { max-width: 1200px; margin: 20px auto; padding: 0 16px; }
    .card { background:#111827; border:1px solid #334155; border-radius:12px; padding:16px; margin-bottom:14px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
    input, select, button, textarea { background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:8px; }
    button { cursor:pointer; }
    button.danger { background:#7f1d1d; border-color:#991b1b; }
    button.good { background:#14532d; border-color:#166534; }
    table { width:100%; border-collapse:collapse; font-size: 13px; }
    th, td { border:1px solid #334155; padding:6px; text-align:left; vertical-align:top; }
    th { background:#1f2937; }
    a { color:#7dd3fc; text-decoration:none; }
    .flash { margin-bottom:10px; padding:10px; border-radius:8px; background:#14532d; border:1px solid #166534; color:#bbf7d0; }
    .dangerText { color:#fca5a5; }
    .muted { color:#94a3b8; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
    ${body}
  </div>
</body>
</html>`;

const redirectWithMsg = (res, path, message) => {
  res.redirect(`${path}?message=${encodeURIComponent(message)}`);
};

const logAdminAction = async (adminId, action, metadata, ipAddress) => {
  await db.query(
    `INSERT INTO admin_logs (admin_id, action, metadata, ip_address, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [adminId ?? null, action, JSON.stringify(metadata ?? {}), ipAddress || null, Date.now()]
  );
};

const getAdminCount = async () => {
  const result = await db.query("SELECT COUNT(*)::int AS c FROM admin_users");
  return result.rows[0]?.c ?? 0;
};

const getSessionFromRequest = async (req) => {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return null;
  const result = await db.query(
    `SELECT s.id, s.admin_id, s.expires_at, a.username
     FROM admin_sessions s
     JOIN admin_users a ON a.id = s.admin_id
     WHERE s.token = $1`,
    [token]
  );
  const session = result.rows[0];
  if (!session) return null;
  if (Number(session.expires_at) <= Date.now()) {
    await db.query("DELETE FROM admin_sessions WHERE token = $1", [token]);
    return null;
  }
  return { token, adminId: session.admin_id, username: session.username };
};

const requireAdminSession = async (req, res, next) => {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      return redirectWithMsg(res, "/admin/login", "Admin oturumu gerekli.");
    }
    req.adminSession = session;
    return next();
  } catch (err) {
    console.error("[admin session] error:", err);
    return res.status(500).send(page("Admin Hata", "<div class='card'>Session kontrolu basarisiz.</div>"));
  }
};

router.get("/", async (req, res) => {
  try {
    const adminCount = await getAdminCount();
    if (adminCount === 0) {
      return res.redirect("/admin/setup");
    }
    const session = await getSessionFromRequest(req);
    if (!session) {
      return res.redirect("/admin/login");
    }

    const message = req.query.message ? String(req.query.message) : "";
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const [
      totalUsers,
      activeUsers,
      bannedUsers,
      tokenSum,
      todayRegistered,
      login24h,
      activeTreasure,
      users,
      suspicious,
      adminLogs,
      selectedUserAvatars,
    ] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS c FROM users"),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE last_active_at >= $1", [dayAgo]),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE is_banned = true"),
      db.query("SELECT COALESCE(SUM(wallet_tokens),0)::bigint AS s FROM users"),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE created_at >= $1", [new Date().setHours(0, 0, 0, 0)]),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE last_login_at >= $1", [dayAgo]),
      db.query("SELECT id, lat, lng, type, value, status, created_at FROM treasures WHERE status='active' LIMIT 1"),
      db.query(
        `SELECT id, username, wallet_tokens, gender, selected_avatar, owned_avatars, is_banned, last_login_at, last_logout_at, created_at
         FROM users ORDER BY id DESC LIMIT 200`
      ),
      db.query(
        `SELECT s.user_id, u.username, s.type, s.message, s.metadata, s.created_at
         FROM suspicious_events s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE ($1::int IS NULL OR s.user_id = $1)
           AND ($2::text = '' OR s.type = $2)
           AND ($3::bool = false OR s.created_at >= $4)
         ORDER BY s.created_at DESC
         LIMIT 200`,
        [
          req.query.user_id ? Number(req.query.user_id) : null,
          req.query.type ? String(req.query.type) : "",
          req.query.last24 === "1",
          dayAgo,
        ]
      ),
      db.query(
        `SELECT l.id, l.action, l.metadata, l.ip_address, l.created_at, a.username
         FROM admin_logs l
         LEFT JOIN admin_users a ON a.id = l.admin_id
         ORDER BY l.created_at DESC
         LIMIT 200`
      ),
      req.query.s_user
        ? db.query("SELECT id, username, owned_avatars, selected_avatar FROM users WHERE id = $1", [
            Number(req.query.s_user),
          ])
        : Promise.resolve({ rows: [] }),
    ]);

    const activeTreasureRow = activeTreasure.rows[0];
    const avatarPriceRows = Array.from({ length: 10 }, (_v, i) => i + 1)
      .map((slot) => `<tr><td>male_${String(slot).padStart(2, "0")}</td><td>${AVATAR_PRICE_BY_SLOT[slot]}</td></tr>
                      <tr><td>female_${String(slot).padStart(2, "0")}</td><td>${AVATAR_PRICE_BY_SLOT[slot]}</td></tr>`)
      .join("");

    const body = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <h2 style="margin:0;">Admin Dashboard</h2>
          <div class="row">
            <span class="muted">Admin: ${esc(session.username)}</span>
            <form method="post" action="/admin/logout"><button class="danger">Logout</button></form>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Ozet</h3>
        <div class="grid">
          <div>Toplam kullanici: <strong>${totalUsers.rows[0].c}</strong></div>
          <div>Aktif kullanici: <strong>${activeUsers.rows[0].c}</strong></div>
          <div>Banli kullanici: <strong>${bannedUsers.rows[0].c}</strong></div>
          <div>Toplam token: <strong>${tokenSum.rows[0].s}</strong></div>
          <div>Bugun kayit: <strong>${todayRegistered.rows[0].c}</strong></div>
          <div>24s login: <strong>${login24h.rows[0].c}</strong></div>
          <div>Aktif treasure: <strong>${activeTreasureRow ? "Var" : "Yok"}</strong></div>
        </div>
      </div>

      <div class="card">
        <h3>Treasure Yonetimi</h3>
        ${
          activeTreasureRow
            ? `<div>Aktif: #${activeTreasureRow.id} (${activeTreasureRow.type}/${activeTreasureRow.value}) @ ${activeTreasureRow.lat}, ${activeTreasureRow.lng}
                 <form method="post" action="/admin/treasures/${activeTreasureRow.id}/deactivate" style="display:inline;">
                   <button class="danger">Deaktive Et</button>
                 </form>
               </div>`
            : "<div class='muted'>Aktif treasure yok.</div>"
        }
        <form method="post" action="/admin/treasures/spawn" class="row" style="margin-top:10px;">
          <input name="lat" type="number" step="any" placeholder="lat" required />
          <input name="lng" type="number" step="any" placeholder="lng" required />
          <input name="type" placeholder="type" value="custom" required />
          <input name="value" type="number" placeholder="value" min="0" required />
          <button class="good">Manuel Spawn</button>
        </form>
      </div>

      <div class="card">
        <h3>Kullanicilar</h3>
        <table><thead><tr>
          <th>id</th><th>username</th><th>wallet</th><th>gender</th><th>selected_avatar</th>
          <th>owned_count</th><th>banned</th><th>last_login</th><th>last_logout</th><th>created</th><th>aksiyonlar</th>
        </tr></thead><tbody>
          ${users.rows
            .map((u) => {
              const owned = Array.isArray(u.owned_avatars) ? u.owned_avatars.length : 0;
              return `<tr>
                <td>${u.id}</td>
                <td>${esc(u.username)}</td>
                <td>${u.wallet_tokens}</td>
                <td>${esc(u.gender)}</td>
                <td>${esc(u.selected_avatar)}</td>
                <td>${owned}</td>
                <td>${u.is_banned ? "true" : "false"}</td>
                <td>${fmtTime(u.last_login_at)}</td>
                <td>${fmtTime(u.last_logout_at)}</td>
                <td>${fmtTime(u.created_at)}</td>
                <td>
                  <form method="post" action="/admin/users/${u.id}/tokens" class="row">
                    <input name="amount" type="number" placeholder="+/- token" required />
                    <input name="reason" placeholder="reason" required />
                    <button class="good">Token Islem</button>
                  </form>
                  <div class="row" style="margin-top:6px;">
                    <form method="post" action="/admin/users/${u.id}/ban"><button class="danger">Ban</button></form>
                    <form method="post" action="/admin/users/${u.id}/unban"><button>Unban</button></form>
                    <a href="/admin?s_user=${u.id}">Avatarlari Gor</a>
                    <a href="/admin?user_id=${u.id}">Suspicious Log</a>
                  </div>
                </td>
              </tr>`;
            })
            .join("")}
        </tbody></table>
      </div>

      <div class="card">
        <h3>Avatar Detay</h3>
        ${
          selectedUserAvatars.rows[0]
            ? `<div>Kullanici: #${selectedUserAvatars.rows[0].id} - ${esc(selectedUserAvatars.rows[0].username)}</div>
               <div>Secili avatar: <strong>${esc(selectedUserAvatars.rows[0].selected_avatar)}</strong></div>
               <pre>${esc(JSON.stringify(selectedUserAvatars.rows[0].owned_avatars || [], null, 2))}</pre>`
            : "<div class='muted'>Kullanici satirindan 'Avatarlari Gor' tikla.</div>"
        }
      </div>

      <div class="card">
        <h3>Suspicious Events</h3>
        <form method="get" action="/admin" class="row">
          <input name="user_id" type="number" placeholder="user id" value="${esc(req.query.user_id || "")}" />
          <input name="type" placeholder="type" value="${esc(req.query.type || "")}" />
          <label><input name="last24" type="checkbox" value="1" ${req.query.last24 === "1" ? "checked" : ""}/> son 24 saat</label>
          <button>Filtrele</button>
          <a href="/admin">Temizle</a>
        </form>
        <table style="margin-top:8px;"><thead><tr><th>user_id</th><th>username</th><th>type</th><th>message</th><th>metadata</th><th>created_at</th></tr></thead><tbody>
          ${suspicious.rows
            .map(
              (s) =>
                `<tr><td>${s.user_id ?? "-"}</td><td>${esc(s.username)}</td><td>${esc(s.type)}</td><td>${esc(
                  s.message
                )}</td><td><pre>${esc(JSON.stringify(s.metadata || {}, null, 2))}</pre></td><td>${fmtTime(s.created_at)}</td></tr>`
            )
            .join("")}
        </tbody></table>
      </div>

      <div class="card">
        <h3>Avatar Fiyat Tablosu</h3>
        <table><thead><tr><th>avatar</th><th>fiyat</th></tr></thead><tbody>${avatarPriceRows}</tbody></table>
      </div>

      <div class="card">
        <h3>Admin Activity Logs</h3>
        <table><thead><tr><th>id</th><th>admin</th><th>action</th><th>metadata</th><th>ip</th><th>created</th></tr></thead><tbody>
          ${adminLogs.rows
            .map(
              (l) =>
                `<tr><td>${l.id}</td><td>${esc(l.username)}</td><td>${esc(l.action)}</td><td><pre>${esc(
                  JSON.stringify(l.metadata || {}, null, 2)
                )}</pre></td><td>${esc(l.ip_address)}</td><td>${fmtTime(l.created_at)}</td></tr>`
            )
            .join("")}
        </tbody></table>
      </div>
    `;

    return res.status(200).send(page("Admin Dashboard", body, message));
  } catch (err) {
    console.error("[GET /admin] error:", err);
    return res.status(500).send(page("Admin Hata", "<div class='card dangerText'>Dashboard yuklenemedi.</div>"));
  }
});

router.get("/setup", async (req, res) => {
  try {
    const adminCount = await getAdminCount();
    if (adminCount > 0) {
      return redirectWithMsg(res, "/admin/login", "Admin zaten olusturulmus.");
    }
    const body = `
      <div class="card">
        <h2>Admin Ilk Kurulum</h2>
        <form method="post" action="/admin/setup" class="row">
          <input name="username" placeholder="username" required />
          <input name="password" type="password" placeholder="password" required />
          <input name="passwordConfirm" type="password" placeholder="password confirm" required />
          <button class="good">Admin Olustur</button>
        </form>
      </div>
    `;
    return res.send(page("Admin Setup", body, req.query.message ? String(req.query.message) : ""));
  } catch (err) {
    return res.status(500).send(page("Admin Hata", "<div class='card'>Setup acilamadi.</div>"));
  }
});

router.post("/setup", async (req, res) => {
  try {
    const adminCount = await getAdminCount();
    if (adminCount > 0) {
      return redirectWithMsg(res, "/admin/login", "Admin zaten mevcut.");
    }
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || "");

    if (!username || !password) {
      return res.status(400).send(page("Admin Setup", "<div class='card dangerText'>Kullanici adi ve sifre gerekli.</div>"));
    }
    if (password.length < 6) {
      return res.status(400).send(page("Admin Setup", "<div class='card dangerText'>Sifre en az 6 karakter olmali.</div>"));
    }
    if (password !== passwordConfirm) {
      return res.status(400).send(page("Admin Setup", "<div class='card dangerText'>Sifreler eslesmiyor.</div>"));
    }

    const hash = await bcrypt.hash(password, 12);
    const now = Date.now();
    const insert = await db.query(
      `INSERT INTO admin_users (username, password_hash, created_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [username, hash, now]
    );
    await logAdminAction(insert.rows[0].id, "admin_setup", { username }, getIp(req));
    return redirectWithMsg(res, "/admin/login", "Admin olusturuldu. Giris yapin.");
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).send(page("Admin Setup", "<div class='card dangerText'>Bu admin username zaten kullaniliyor.</div>"));
    }
    return res.status(500).send(page("Admin Setup", "<div class='card dangerText'>Admin olusturulamadi.</div>"));
  }
});

router.get("/login", async (req, res) => {
  try {
    const adminCount = await getAdminCount();
    if (adminCount === 0) {
      return res.redirect("/admin/setup");
    }
    const existing = await getSessionFromRequest(req);
    if (existing) return res.redirect("/admin");

    const body = `
      <div class="card">
        <h2>Admin Login</h2>
        <form method="post" action="/admin/login" class="row">
          <input name="username" placeholder="username" required />
          <input name="password" type="password" placeholder="password" required />
          <button class="good">Giris</button>
        </form>
      </div>
    `;
    return res.send(page("Admin Login", body, req.query.message ? String(req.query.message) : ""));
  } catch (err) {
    return res.status(500).send(page("Admin Login", "<div class='card dangerText'>Login sayfasi acilamadi.</div>"));
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password) {
      return res.status(400).send(page("Admin Login", "<div class='card dangerText'>username/password zorunlu.</div>"));
    }
    const adminResult = await db.query(
      "SELECT id, username, password_hash FROM admin_users WHERE username = $1",
      [username]
    );
    const admin = adminResult.rows[0];
    if (!admin) {
      return res.status(401).send(page("Admin Login", "<div class='card dangerText'>Kimlik bilgileri hatali.</div>"));
    }
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      return res.status(401).send(page("Admin Login", "<div class='card dangerText'>Kimlik bilgileri hatali.</div>"));
    }
    const token = crypto.randomBytes(48).toString("hex");
    const now = Date.now();
    await db.query(
      `INSERT INTO admin_sessions (admin_id, token, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [admin.id, token, now, now + SESSION_TTL_MS]
    );
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(now + SESSION_TTL_MS),
    });
    await logAdminAction(admin.id, "admin_login", { username: admin.username }, getIp(req));
    return res.redirect("/admin");
  } catch (err) {
    return res.status(500).send(page("Admin Login", "<div class='card dangerText'>Giris basarisiz.</div>"));
  }
});

router.post("/logout", requireAdminSession, async (req, res) => {
  try {
    await db.query("DELETE FROM admin_sessions WHERE token = $1", [req.adminSession.token]);
    res.clearCookie(ADMIN_COOKIE);
    await logAdminAction(req.adminSession.adminId, "admin_logout", {}, getIp(req));
    return redirectWithMsg(res, "/admin/login", "Cikis yapildi.");
  } catch (err) {
    return res.status(500).send(page("Admin Logout", "<div class='card dangerText'>Cikis basarisiz.</div>"));
  }
});

router.post("/users/:id/tokens", requireAdminSession, async (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || "").trim();
  if (!Number.isFinite(userId) || !Number.isFinite(amount) || !reason) {
    return redirectWithMsg(res, "/admin", "Gecersiz token ayarlama istegi.");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      "SELECT id, wallet_tokens FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin", "Kullanici bulunamadi.");
    }
    const next = Number(user.wallet_tokens) + amount;
    if (next < 0) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin", "Wallet eksiye dusurulemez.");
    }
    await client.query("UPDATE users SET wallet_tokens = $1 WHERE id = $2", [next, userId]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, treasure_id, amount, type, created_at)
       VALUES ($1, NULL, $2, 'admin_adjustment', $3)`,
      [userId, amount, Date.now()]
    );
    await client.query("COMMIT");
    await logAdminAction(
      req.adminSession.adminId,
      "admin_token_adjustment",
      { userId, amount, reason, newBalance: next },
      getIp(req)
    );
    return redirectWithMsg(res, "/admin", "Token guncellendi.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return redirectWithMsg(res, "/admin", "Token guncelleme basarisiz.");
  } finally {
    client.release();
  }
});

router.post("/users/:id/ban", requireAdminSession, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    await db.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);
    await logAdminAction(req.adminSession.adminId, "admin_ban_user", { userId }, getIp(req));
    return redirectWithMsg(res, "/admin", "Kullanici banlandi.");
  } catch (err) {
    return redirectWithMsg(res, "/admin", "Ban islemi basarisiz.");
  }
});

router.post("/users/:id/unban", requireAdminSession, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    await db.query("UPDATE users SET is_banned = false WHERE id = $1", [userId]);
    await logAdminAction(req.adminSession.adminId, "admin_unban_user", { userId }, getIp(req));
    return redirectWithMsg(res, "/admin", "Kullanici ban kaldirildi.");
  } catch (err) {
    return redirectWithMsg(res, "/admin", "Unban islemi basarisiz.");
  }
});

router.post("/treasures/spawn", requireAdminSession, async (req, res) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const type = String(req.body.type || "custom").slice(0, 40);
    const value = Number(req.body.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(value) || value < 0) {
      return redirectWithMsg(res, "/admin", "Gecersiz treasure degeri.");
    }
    const now = Date.now();
    const insert = await db.query(
      `INSERT INTO treasures (lat, lng, type, value, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id`,
      [lat, lng, type, value, now]
    );
    await logAdminAction(
      req.adminSession.adminId,
      "admin_treasure_spawn",
      { treasureId: insert.rows[0].id, lat, lng, type, value },
      getIp(req)
    );
    return redirectWithMsg(res, "/admin", "Treasure spawn edildi.");
  } catch (err) {
    return redirectWithMsg(res, "/admin", "Treasure spawn basarisiz.");
  }
});

router.post("/treasures/:id/deactivate", requireAdminSession, async (req, res) => {
  try {
    const treasureId = Number(req.params.id);
    await db.query(
      `UPDATE treasures
       SET status = 'inactive'
       WHERE id = $1 AND status = 'active'`,
      [treasureId]
    );
    await logAdminAction(req.adminSession.adminId, "admin_treasure_deactivate", { treasureId }, getIp(req));
    return redirectWithMsg(res, "/admin", "Aktif treasure deaktive edildi.");
  } catch (err) {
    return redirectWithMsg(res, "/admin", "Treasure deaktive islemi basarisiz.");
  }
});

module.exports = router;
