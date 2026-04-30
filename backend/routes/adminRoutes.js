const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { db } = require("../db");

const router = express.Router();

const ADMIN_COOKIE = "admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_PRICE_BY_SLOT = { 1: 0, 2: 0, 3: 0, 4: 100, 5: 500, 6: 1500, 7: 2500, 8: 6000, 9: 10000, 10: 15000 };
const SUSPICIOUS_TYPE_TR = {
  impossible_speed: "Imkansiz hiz",
  collect_too_far: "Uzak hazine toplama denemesi",
  duplicate_collect: "Tekrar toplama denemesi",
  rate_limit_collect: "Cok hizli toplama istegi",
  invalid_avatar_purchase: "Gecersiz avatar satin alma",
  insufficient_tokens_purchase: "Yetersiz token satin alma denemesi",
  gender_change_attempt: "Cinsiyet degistirme denemesi",
};
const ADMIN_ACTION_TR = {
  admin_setup: "Admin kurulumu",
  admin_login: "Admin giris",
  admin_logout: "Admin cikis",
  admin_token_adjustment: "Token duzenleme",
  admin_ban_user: "Kullanici banlama",
  admin_unban_user: "Kullanici ban kaldirma",
  admin_treasure_spawn: "Hazine olusturma",
  admin_treasure_deactivate: "Aktif hazineyi kapatma",
};

const esc = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const fmtTime = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString("tr-TR");
};
const toOwnedCount = (owned) => (Array.isArray(owned) ? owned.length : 0);
const parseIntSafe = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const getIp = (req) =>
  (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || "unknown";

const nav = (current) => {
  const links = [
    ["/admin", "Ana Panel"],
    ["/admin/users", "Kayitli Oyuncular"],
    ["/admin/tokens", "Token Yonetimi"],
    ["/admin/bans", "Ban Yonetimi"],
    ["/admin/suspicious", "Supheli Hareketler"],
    ["/admin/treasures", "Hazine Yonetimi"],
    ["/admin/avatars", "Avatar Ekonomisi"],
    ["/admin/logs", "Admin Islem Kayitlari"],
  ];
  return `<div class="topbar">
    <div class="brand">Admin Paneli</div>
    <div class="navlinks">
      ${links
        .map(
          ([href, label]) =>
            `<a class="navlink ${current === href ? "active" : ""}" href="${href}">${esc(label)}</a>`
        )
        .join("")}
    </div>
    <form method="post" action="/admin/logout"><button class="btn danger">Cikis Yap</button></form>
  </div>`;
};

const page = (title, current, content, flash = {}) => `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#0f172a; color:#e2e8f0; }
    .wrap { max-width: 1280px; margin: 16px auto; padding: 0 16px 30px; }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; }
    .brand { font-weight:800; font-size:22px; color:#e2e8f0; }
    .navlinks { display:flex; gap:8px; flex-wrap:wrap; }
    .navlink { color:#7dd3fc; border:1px solid #334155; padding:8px 10px; border-radius:9px; text-decoration:none; background:#111827; }
    .navlink.active { background:#1d4ed8; color:#dbeafe; border-color:#3b82f6; }
    .card { background:#111827; border:1px solid #334155; border-radius:12px; padding:16px; margin-bottom:14px; }
    .card h1, .card h2, .card h3, .card p { margin:0 0 10px; }
    .muted { color:#94a3b8; font-size:13px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
    .menuGrid { display:grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .menuCard { display:block; border:1px solid #334155; border-radius:12px; background:#0b1220; color:#e2e8f0; text-decoration:none; padding:14px; }
    .menuCard strong { display:block; margin-bottom:6px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { border:1px solid #334155; padding:7px; text-align:left; vertical-align:top; }
    th { background:#1f2937; }
    input, select, textarea, button { background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:8px; }
    button { cursor:pointer; }
    .btn { padding:8px 12px; }
    .good { background:#14532d; border-color:#166534; }
    .danger { background:#7f1d1d; border-color:#991b1b; }
    .warn { background:#78350f; border-color:#92400e; }
    .flash { margin-bottom:10px; padding:10px; border-radius:8px; border:1px solid; }
    .flash.ok { background:#14532d; border-color:#166534; color:#bbf7d0; }
    .flash.err { background:#7f1d1d; border-color:#991b1b; color:#fecaca; }
    .flash.warn { background:#78350f; border-color:#92400e; color:#fde68a; }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; }
  </style>
</head>
<body>
  <div class="wrap">
    ${nav(current)}
    ${flash.message ? `<div class="flash ${flash.kind || "ok"}">${esc(flash.message)}</div>` : ""}
    ${content}
  </div>
</body>
</html>`;

const authPage = (title, body, flash = {}) => `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif}
.wrap{max-width:560px;margin:60px auto;padding:0 16px}
.card{background:#111827;border:1px solid #334155;border-radius:12px;padding:16px}
input,button{width:100%;margin-bottom:10px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:10px}
button{cursor:pointer;background:#14532d;border-color:#166534}
.flash{margin-bottom:10px;padding:10px;border-radius:8px;border:1px solid}
.ok{background:#14532d;border-color:#166534;color:#bbf7d0}.err{background:#7f1d1d;border-color:#991b1b;color:#fecaca}
</style></head><body><div class="wrap">${flash.message ? `<div class="flash ${flash.kind || "ok"}">${esc(flash.message)}</div>` : ""}${body}</div></body></html>`;

const getFlash = (req) => ({
  message: req.query.message ? String(req.query.message) : "",
  kind: req.query.kind ? String(req.query.kind) : "ok",
});
const redirectWithMsg = (res, path, message, kind = "ok") =>
  res.redirect(`${path}?message=${encodeURIComponent(message)}&kind=${encodeURIComponent(kind)}`);
const typeTr = (type) => SUSPICIOUS_TYPE_TR[type] || type;
const actionTr = (action) => ADMIN_ACTION_TR[action] || action;

const logAdminAction = async (adminId, action, metadata, ipAddress) => {
  await db.query(
    `INSERT INTO admin_logs (admin_id, action, metadata, ip_address, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [adminId ?? null, action, JSON.stringify(metadata ?? {}), ipAddress || null, Date.now()]
  );
};
const getAdminCount = async () => (await db.query("SELECT COUNT(*)::int AS c FROM admin_users")).rows[0]?.c ?? 0;

const getSessionFromRequest = async (req) => {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return null;
  const result = await db.query(
    `SELECT s.admin_id, s.expires_at, a.username
     FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.token = $1`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await db.query("DELETE FROM admin_sessions WHERE token = $1", [token]);
    return null;
  }
  return { token, adminId: row.admin_id, username: row.username };
};

const requireAdminSession = async (req, res, next) => {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) return redirectWithMsg(res, "/admin/login", "Admin oturumu gerekli.", "warn");
    req.adminSession = session;
    return next();
  } catch (err) {
    console.error("[admin session] error:", err);
    return res.status(500).send(authPage("Admin Hata", "<div class='card'>Oturum kontrolu basarisiz.</div>", { kind: "err" }));
  }
};

router.get("/setup", async (req, res) => {
  try {
    if ((await getAdminCount()) > 0) return redirectWithMsg(res, "/admin/login", "Admin zaten olusturulmus.", "warn");
    const body = `<div class="card">
      <h2>Admin Kurulumu</h2>
      <p>Bu ekran sadece bir kere kullanilir.</p>
      <form method="post" action="/admin/setup">
        <input name="username" placeholder="Kullanici adi" required />
        <input name="password" type="password" placeholder="Sifre" required />
        <input name="passwordConfirm" type="password" placeholder="Sifre Tekrar" required />
        <button>Admin Olustur</button>
      </form>
    </div>`;
    return res.send(authPage("Admin Kurulumu", body, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(authPage("Admin Kurulumu", "<div class='card'>Kurulum sayfasi acilamadi.</div>", { kind: "err" }));
  }
});

router.post("/setup", async (req, res) => {
  try {
    if ((await getAdminCount()) > 0) return redirectWithMsg(res, "/admin/login", "Admin zaten mevcut.", "warn");
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || "");
    if (!username || !password) return res.status(400).send(authPage("Admin Kurulumu", "<div class='card'>Kullanici adi ve sifre gerekli.</div>", { kind: "err" }));
    if (password.length < 6) return res.status(400).send(authPage("Admin Kurulumu", "<div class='card'>Sifre en az 6 karakter olmali.</div>", { kind: "err" }));
    if (password !== passwordConfirm) return res.status(400).send(authPage("Admin Kurulumu", "<div class='card'>Sifreler eslesmiyor.</div>", { kind: "err" }));
    const hash = await bcrypt.hash(password, 12);
    const insert = await db.query(
      "INSERT INTO admin_users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
      [username, hash, Date.now()]
    );
    await logAdminAction(insert.rows[0].id, "admin_setup", { username }, getIp(req));
    return redirectWithMsg(res, "/admin/login", "Admin olusturuldu. Giris yapabilirsiniz.");
  } catch (err) {
    if (err.code === "23505") return res.status(409).send(authPage("Admin Kurulumu", "<div class='card'>Bu kullanici adi kullaniliyor.</div>", { kind: "err" }));
    return res.status(500).send(authPage("Admin Kurulumu", "<div class='card'>Admin olusturulamadi.</div>", { kind: "err" }));
  }
});

router.get("/login", async (req, res) => {
  try {
    if ((await getAdminCount()) === 0) return res.redirect("/admin/setup");
    if (await getSessionFromRequest(req)) return res.redirect("/admin");
    const body = `<div class="card">
      <h2>Giris Yap</h2>
      <p>Admin paneline giris yapin.</p>
      <form method="post" action="/admin/login">
        <input name="username" placeholder="Kullanici adi" required />
        <input name="password" type="password" placeholder="Sifre" required />
        <button>Giris Yap</button>
      </form>
    </div>`;
    return res.send(authPage("Admin Giris", body, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(authPage("Admin Giris", "<div class='card'>Giris sayfasi acilamadi.</div>", { kind: "err" }));
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password) return res.status(400).send(authPage("Admin Giris", "<div class='card'>Kullanici adi ve sifre zorunlu.</div>", { kind: "err" }));
    const adminResult = await db.query("SELECT id, username, password_hash FROM admin_users WHERE username = $1", [username]);
    const admin = adminResult.rows[0];
    if (!admin) return res.status(401).send(authPage("Admin Giris", "<div class='card'>Kimlik bilgileri hatali.</div>", { kind: "err" }));
    if (!(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).send(authPage("Admin Giris", "<div class='card'>Kimlik bilgileri hatali.</div>", { kind: "err" }));
    }
    const now = Date.now();
    const token = crypto.randomBytes(48).toString("hex");
    await db.query("INSERT INTO admin_sessions (admin_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      admin.id,
      token,
      now,
      now + SESSION_TTL_MS,
    ]);
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(now + SESSION_TTL_MS),
    });
    await logAdminAction(admin.id, "admin_login", { username: admin.username }, getIp(req));
    return res.redirect("/admin");
  } catch (_e) {
    return res.status(500).send(authPage("Admin Giris", "<div class='card'>Giris basarisiz.</div>", { kind: "err" }));
  }
});

router.post("/logout", requireAdminSession, async (req, res) => {
  try {
    await db.query("DELETE FROM admin_sessions WHERE token = $1", [req.adminSession.token]);
    res.clearCookie(ADMIN_COOKIE);
    await logAdminAction(req.adminSession.adminId, "admin_logout", {}, getIp(req));
    return redirectWithMsg(res, "/admin/login", "Cikis yapildi.");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/login", "Cikis basarisiz.", "err");
  }
});

router.get("/", requireAdminSession, async (req, res) => {
  try {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const [uAll, uActive, uBanned, tokenSum, todayReg, logins, activeTreasure, suspiciousCount] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS c FROM users"),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE last_active_at >= $1", [dayAgo]),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE is_banned = true"),
      db.query("SELECT COALESCE(SUM(wallet_tokens),0)::bigint AS s FROM users"),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE created_at >= $1", [startOfDay]),
      db.query("SELECT COUNT(*)::int AS c FROM users WHERE last_login_at >= $1", [dayAgo]),
      db.query("SELECT id FROM treasures WHERE status = 'active' LIMIT 1"),
      db.query("SELECT COUNT(*)::int AS c FROM suspicious_events WHERE created_at >= $1", [dayAgo]),
    ]);
    const cards = [
      ["Toplam Kullanici", uAll.rows[0].c],
      ["Aktif Kullanici", uActive.rows[0].c],
      ["Banli Kullanici", uBanned.rows[0].c],
      ["Toplam Token", tokenSum.rows[0].s],
      ["Bugun Kayit Olan", todayReg.rows[0].c],
      ["Son 24 Saat Login", logins.rows[0].c],
      ["Aktif Hazine Durumu", activeTreasure.rows[0] ? "Var" : "Yok"],
      ["Supheli Olay Sayisi", suspiciousCount.rows[0].c],
    ]
      .map(([k, v]) => `<div class="card"><div class="muted">${esc(k)}</div><h2>${esc(v)}</h2></div>`)
      .join("");
    const menu = [
      ["/admin/users", "Kayitli Oyuncular", "Oyuncu listesi, detay ve arama"],
      ["/admin/tokens", "Token Yonetimi", "Token ekleme/silme islemleri"],
      ["/admin/bans", "Ban Yonetimi", "Banli oyuncular ve ban islemleri"],
      ["/admin/suspicious", "Supheli Hareketler", "Supheli olaylari filtrele ve incele"],
      ["/admin/treasures", "Hazine Yonetimi", "Aktif hazine ve manuel olusturma"],
      ["/admin/avatars", "Avatar Ekonomisi", "Avatar fiyat tablosu"],
      ["/admin/logs", "Admin Islem Kayitlari", "Admin aksiyon gecmisi"],
    ]
      .map(([href, title, desc]) => `<a class="menuCard" href="${href}"><strong>${esc(title)}</strong><span class="muted">${esc(desc)}</span></a>`)
      .join("");
    const content = `
      <div class="card"><h1>Ana Panel</h1><p>Genel ozet ve yonetim menuleri.</p></div>
      <div class="grid">${cards}</div>
      <div class="card"><h3>Yonetim Menuleri</h3><div class="menuGrid">${menu}</div></div>`;
    return res.send(page("Ana Panel", "/admin", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Ana Panel", "/admin", "<div class='card'>Panel yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/users", requireAdminSession, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const id = parseIntSafe(req.query.id);
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`username ILIKE $${params.length}`);
    }
    if (id !== null) {
      params.push(id);
      where.push(`id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await db.query(
      `SELECT id, username, wallet_tokens, gender, selected_avatar, owned_avatars, is_banned, last_login_at, last_logout_at, created_at
       FROM users ${whereSql} ORDER BY id DESC LIMIT 300`,
      params
    );
    const rows = result.rows
      .map(
        (u) => `<tr>
          <td>${u.id}</td><td>${esc(u.username)}</td><td>${u.wallet_tokens}</td><td>${esc(u.gender)}</td>
          <td>${esc(u.selected_avatar)}</td><td>${toOwnedCount(u.owned_avatars)}</td><td>${u.is_banned ? "Banli" : "Aktif"}</td>
          <td>${fmtTime(u.last_login_at)}</td><td>${fmtTime(u.last_logout_at)}</td><td>${fmtTime(u.created_at)}</td>
          <td class="row">
            <a class="navlink" href="/admin/users/${u.id}">Detay Gor</a>
            <a class="navlink" href="/admin/tokens?user_id=${u.id}">Token Duzenle</a>
            ${
              u.is_banned
                ? `<form method="post" action="/admin/users/${u.id}/unban"><input type="hidden" name="redirectTo" value="/admin/users" /><button class="btn">Bani Kaldir</button></form>`
                : `<form method="post" action="/admin/users/${u.id}/ban"><input type="hidden" name="redirectTo" value="/admin/users" /><button class="btn danger">Banla</button></form>`
            }
          </td>
        </tr>`
      )
      .join("");
    const content = `
      <div class="card"><h1>Kayitli Oyuncular</h1><p class="muted">Kullanici adi veya ID ile arama yapabilirsiniz.</p></div>
      <div class="card">
        <form method="get" action="/admin/users" class="row">
          <input name="q" placeholder="Kullanici adina gore ara" value="${esc(q)}" />
          <input name="id" type="number" placeholder="ID ile ara" value="${esc(req.query.id || "")}" />
          <button class="btn">Ara</button>
          <a class="navlink" href="/admin/users">Temizle</a>
        </form>
      </div>
      <div class="card"><table><thead><tr>
        <th>ID</th><th>Kullanici Adi</th><th>Token</th><th>Cinsiyet</th><th>Secili Avatar</th><th>Sahip Avatar</th><th>Ban Durumu</th><th>Son Giris</th><th>Son Cikis</th><th>Kayit Tarihi</th><th>Aksiyon</th>
      </tr></thead><tbody>${rows || "<tr><td colspan='11'>Kayit bulunamadi.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Kayitli Oyuncular", "/admin/users", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Kayitli Oyuncular", "/admin/users", "<div class='card'>Kullanici listesi yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/users/:id", requireAdminSession, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const [userResult, suspiciousResult, txResult] = await Promise.all([
      db.query("SELECT * FROM users WHERE id = $1", [userId]),
      db.query(
        `SELECT id, type, message, metadata, created_at
         FROM suspicious_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId]
      ),
      db.query(
        `SELECT id, amount, type, treasure_id, created_at
         FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId]
      ),
    ]);
    const user = userResult.rows[0];
    if (!user) return redirectWithMsg(res, "/admin/users", "Kullanici bulunamadi.", "warn");
    const suspiciousRows = suspiciousResult.rows
      .map((s) => `<tr><td>${s.id}</td><td>${esc(typeTr(s.type))}</td><td>${esc(s.message)}</td><td><pre>${esc(JSON.stringify(s.metadata || {}, null, 2))}</pre></td><td>${fmtTime(s.created_at)}</td></tr>`)
      .join("");
    const txRows = txResult.rows
      .map((t) => `<tr><td>${t.id}</td><td>${t.amount}</td><td>${esc(t.type)}</td><td>${t.treasure_id ?? "-"}</td><td>${fmtTime(t.created_at)}</td></tr>`)
      .join("");
    const content = `
      <div class="card"><h1>Oyuncu Detayi #${user.id}</h1><p class="muted">Temel bilgiler, supheli olaylar ve son cuzdan hareketleri.</p></div>
      <div class="card"><div class="grid">
        <div><strong>Kullanici Adi:</strong> ${esc(user.username)}</div>
        <div><strong>Token:</strong> ${user.wallet_tokens}</div>
        <div><strong>Cinsiyet:</strong> ${esc(user.gender)}</div>
        <div><strong>Secili Avatar:</strong> ${esc(user.selected_avatar)}</div>
        <div><strong>Ban Durumu:</strong> ${user.is_banned ? "Banli" : "Aktif"}</div>
        <div><strong>Son Giris:</strong> ${fmtTime(user.last_login_at)}</div>
        <div><strong>Son Cikis:</strong> ${fmtTime(user.last_logout_at)}</div>
        <div><strong>Kayit Tarihi:</strong> ${fmtTime(user.created_at)}</div>
      </div><div style="margin-top:10px;"><strong>Owned Avatars</strong><pre>${esc(JSON.stringify(user.owned_avatars || [], null, 2))}</pre></div></div>
      <div class="card"><div class="row">
        <a class="navlink" href="/admin/tokens?user_id=${user.id}&mode=add">Token Ekle</a>
        <a class="navlink" href="/admin/tokens?user_id=${user.id}&mode=remove">Token Sil</a>
        ${
          user.is_banned
            ? `<form method="post" action="/admin/users/${user.id}/unban"><input type="hidden" name="redirectTo" value="/admin/users/${user.id}" /><button class="btn">Bani Kaldir</button></form>`
            : `<form method="post" action="/admin/users/${user.id}/ban"><input type="hidden" name="redirectTo" value="/admin/users/${user.id}" /><button class="btn danger">Banla</button></form>`
        }
        <a class="navlink" href="/admin/users">Geri Don</a>
      </div></div>
      <div class="card"><h3>Supheli Hareketler</h3><table><thead><tr><th>ID</th><th>Tip</th><th>Mesaj</th><th>Metadata</th><th>Tarih</th></tr></thead><tbody>${suspiciousRows || "<tr><td colspan='5'>Kayit yok.</td></tr>"}</tbody></table></div>
      <div class="card"><h3>Son 20 Wallet Islemi</h3><table><thead><tr><th>ID</th><th>Miktar</th><th>Tip</th><th>Treasure ID</th><th>Tarih</th></tr></thead><tbody>${txRows || "<tr><td colspan='5'>Islem yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Oyuncu Detayi", "/admin/users", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Oyuncu Detayi", "/admin/users", "<div class='card'>Detay sayfasi yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/tokens", requireAdminSession, async (req, res) => {
  const userId = esc(req.query.user_id || "");
  const mode = String(req.query.mode || "add");
  const content = `
    <div class="card"><h1>Token Yonetimi</h1><p class="muted">Kullanici ID, miktar ve sebep girerek token islemi yapin.</p></div>
    <div class="card">
      <form method="post" action="/admin/tokens/adjust" class="row">
        <input type="number" name="userId" placeholder="Kullanici ID" value="${userId}" required />
        <input type="number" name="amount" placeholder="Miktar" required />
        <select name="operation">
          <option value="add" ${mode === "add" ? "selected" : ""}>Ekle</option>
          <option value="remove" ${mode === "remove" ? "selected" : ""}>Sil</option>
        </select>
        <input name="reason" placeholder="Sebep (zorunlu)" required />
        <button class="btn good">Gonder</button>
      </form>
      <p class="muted">Not: Token eksiye dusmez. Islem hem wallet_transactions hem admin_logs tablosuna yazilir.</p>
    </div>`;
  return res.send(page("Token Yonetimi", "/admin/tokens", content, getFlash(req)));
});

router.get("/bans", requireAdminSession, async (req, res) => {
  try {
    const banned = await db.query(
      `SELECT id, username, wallet_tokens, last_login_at, is_banned
       FROM users WHERE is_banned = true ORDER BY id DESC LIMIT 300`
    );
    const rows = banned.rows
      .map(
        (u) => `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${u.wallet_tokens}</td><td>${fmtTime(
          u.last_login_at
        )}</td><td>${u.is_banned ? "Banli" : "Aktif"}</td><td><form method="post" action="/admin/users/${u.id}/unban"><input type="hidden" name="redirectTo" value="/admin/bans" /><button class="btn">Bani Kaldir</button></form></td></tr>`
      )
      .join("");
    const content = `
      <div class="card"><h1>Ban Yonetimi</h1><p class="muted">Banli oyuncular listesi ve ID ile banlama.</p></div>
      <div class="card">
        <form method="post" action="/admin/users/ban-by-id" class="row">
          <input type="number" name="userId" placeholder="Banlanacak kullanici ID" required />
          <button class="btn danger">Kullaniciyi Banla</button>
        </form>
      </div>
      <div class="card"><table><thead><tr><th>ID</th><th>Kullanici Adi</th><th>Token</th><th>Son Giris</th><th>Ban Durumu</th><th>Aksiyon</th></tr></thead><tbody>${rows || "<tr><td colspan='6'>Banli kullanici yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Ban Yonetimi", "/admin/bans", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Ban Yonetimi", "/admin/bans", "<div class='card'>Ban listesi yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/suspicious", requireAdminSession, async (req, res) => {
  try {
    const now = Date.now();
    const last24 = now - 24 * 60 * 60 * 1000;
    const last7 = now - 7 * 24 * 60 * 60 * 1000;
    const userId = parseIntSafe(req.query.user_id);
    const type = String(req.query.type || "").trim();
    const period = String(req.query.period || "");
    const where = [];
    const params = [];
    if (userId !== null) {
      params.push(userId);
      where.push(`s.user_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      where.push(`s.type = $${params.length}`);
    }
    if (period === "24h") {
      params.push(last24);
      where.push(`s.created_at >= $${params.length}`);
    }
    if (period === "7d") {
      params.push(last7);
      where.push(`s.created_at >= $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await db.query(
      `SELECT s.id, s.user_id, u.username, s.type, s.message, s.metadata, s.created_at
       FROM suspicious_events s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.created_at DESC
       LIMIT 300`,
      params
    );
    const typeOptions = Object.keys(SUSPICIOUS_TYPE_TR)
      .map((k) => `<option value="${k}" ${type === k ? "selected" : ""}>${esc(typeTr(k))}</option>`)
      .join("");
    const rows = result.rows
      .map(
        (s) => `<tr><td>${s.id}</td><td>${s.user_id ?? "-"}</td><td>${esc(s.username)}</td><td>${esc(
          typeTr(s.type)
        )}</td><td>${esc(s.message)}</td><td><pre>${esc(JSON.stringify(s.metadata || {}, null, 2))}</pre></td><td>${fmtTime(s.created_at)}</td></tr>`
      )
      .join("");
    const content = `
      <div class="card"><h1>Supheli Hareketler</h1><p class="muted">Tip, kullanici ve zaman araligina gore filtreleyin.</p></div>
      <div class="card">
        <form method="get" action="/admin/suspicious" class="row">
          <input name="user_id" type="number" placeholder="Kullanici ID" value="${esc(req.query.user_id || "")}" />
          <select name="type"><option value="">Tum tipler</option>${typeOptions}</select>
          <select name="period">
            <option value="" ${period === "" ? "selected" : ""}>Tum zamanlar</option>
            <option value="24h" ${period === "24h" ? "selected" : ""}>Son 24 saat</option>
            <option value="7d" ${period === "7d" ? "selected" : ""}>Son 7 gun</option>
          </select>
          <button class="btn">Filtrele</button>
          <a class="navlink" href="/admin/suspicious">Temizle</a>
        </form>
      </div>
      <div class="card"><table><thead><tr><th>ID</th><th>Kullanici ID</th><th>Kullanici Adi</th><th>Tip</th><th>Mesaj</th><th>Metadata</th><th>Tarih</th></tr></thead><tbody>${rows || "<tr><td colspan='7'>Kayit yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Supheli Hareketler", "/admin/suspicious", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Supheli Hareketler", "/admin/suspicious", "<div class='card'>Supheli olaylar yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/treasures", requireAdminSession, async (req, res) => {
  try {
    const [activeResult, history] = await Promise.all([
      db.query("SELECT id, lat, lng, type, value, status, created_at FROM treasures WHERE status='active' LIMIT 1"),
      db.query("SELECT id, lat, lng, type, value, status, created_at FROM treasures ORDER BY created_at DESC LIMIT 100"),
    ]);
    const active = activeResult.rows[0];
    const rows = history.rows
      .map((t) => `<tr><td>${t.id}</td><td>${t.lat}</td><td>${t.lng}</td><td>${esc(t.type)}</td><td>${t.value}</td><td>${esc(t.status)}</td><td>${fmtTime(t.created_at)}</td></tr>`)
      .join("");
    const content = `
      <div class="card"><h1>Hazine Yonetimi</h1><p class="muted">Aktif hazine durumu ve manuel hazine olusturma islemleri.</p></div>
      <div class="card">
        <h3>Aktif Hazine</h3>
        ${
          active
            ? `<p>ID #${active.id} | ${active.lat}, ${active.lng} | ${esc(active.type)} | ${active.value}</p>
              <form method="post" action="/admin/treasures/${active.id}/deactivate">
                <input type="hidden" name="redirectTo" value="/admin/treasures" />
                <button class="btn danger">Aktif Hazineyi Kapat</button>
              </form>`
            : "<p>Aktif hazine yok.</p>"
        }
      </div>
      <div class="card">
        <h3>Manuel Hazine Olustur</h3>
        <form method="post" action="/admin/treasures/spawn" class="row">
          <input type="hidden" name="redirectTo" value="/admin/treasures" />
          <input name="lat" type="number" step="any" placeholder="lat" required />
          <input name="lng" type="number" step="any" placeholder="lng" required />
          <input name="type" placeholder="Tur" value="custom" required />
          <input name="value" type="number" min="0" placeholder="Deger" required />
          <button class="btn good">Hazine Olustur</button>
        </form>
      </div>
      <div class="card"><h3>Hazine Gecmisi</h3><table><thead><tr><th>ID</th><th>Lat</th><th>Lng</th><th>Tur</th><th>Deger</th><th>Durum</th><th>Tarih</th></tr></thead><tbody>${rows || "<tr><td colspan='7'>Kayit yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Hazine Yonetimi", "/admin/treasures", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Hazine Yonetimi", "/admin/treasures", "<div class='card'>Hazine bilgileri yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.get("/avatars", requireAdminSession, async (req, res) => {
  const rows = Array.from({ length: 10 }, (_, i) => i + 1)
    .flatMap((slot) => {
      const price = AVATAR_PRICE_BY_SLOT[slot];
      const flags = [price === 0 ? "Evet" : "Hayir", price > 0 ? "Evet" : "Hayir"];
      return [
        [`male_${String(slot).padStart(2, "0")}`, "male", price, ...flags],
        [`female_${String(slot).padStart(2, "0")}`, "female", price, ...flags],
      ];
    })
    .map(([id, gender, price, free, premium]) => `<tr><td>${id}</td><td>${gender}</td><td>${price}</td><td>${free}</td><td>${premium}</td></tr>`)
    .join("");
  const content = `
    <div class="card"><h1>Avatar Ekonomisi</h1><p class="muted">Fiyatlar backend sabitleri ile gosterilir. (Ileride duzenlenebilir yapida)</p></div>
    <div class="card"><table><thead><tr><th>Avatar ID</th><th>Cinsiyet</th><th>Fiyat</th><th>Ucretsiz mi?</th><th>Premium mu?</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return res.send(page("Avatar Ekonomisi", "/admin/avatars", content, getFlash(req)));
});

router.get("/logs", requireAdminSession, async (req, res) => {
  try {
    const logs = await db.query(
      `SELECT l.admin_id, a.username, l.action, l.metadata, l.ip_address, l.created_at
       FROM admin_logs l LEFT JOIN admin_users a ON a.id = l.admin_id
       ORDER BY l.created_at DESC LIMIT 300`
    );
    const rows = logs.rows
      .map(
        (l) => `<tr><td>${l.admin_id ?? "-"}</td><td>${esc(l.username)}</td><td>${esc(actionTr(l.action))}</td><td><pre>${esc(
          JSON.stringify(l.metadata || {}, null, 2)
        )}</pre></td><td>${esc(l.ip_address)}</td><td>${fmtTime(l.created_at)}</td></tr>`
      )
      .join("");
    const content = `
      <div class="card"><h1>Admin Islem Kayitlari</h1><p class="muted">Yapilan tum admin islemleri listelenir.</p></div>
      <div class="card"><table><thead><tr><th>Admin ID</th><th>Admin</th><th>Islem</th><th>Metadata</th><th>IP</th><th>Tarih</th></tr></thead><tbody>${rows || "<tr><td colspan='6'>Kayit yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Admin Islem Kayitlari", "/admin/logs", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Admin Islem Kayitlari", "/admin/logs", "<div class='card'>Loglar yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

router.post("/tokens/adjust", requireAdminSession, async (req, res) => {
  const userId = Number(req.body.userId);
  const amountRaw = Number(req.body.amount);
  const operation = String(req.body.operation || "add");
  const reason = String(req.body.reason || "").trim();
  const finalAmount = operation === "remove" ? -Math.abs(amountRaw) : Math.abs(amountRaw);
  if (!Number.isFinite(userId) || !Number.isFinite(finalAmount) || !reason) {
    return redirectWithMsg(res, "/admin/tokens", "Gecersiz token islemi.", "err");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query("SELECT id, wallet_tokens FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Kullanici bulunamadi.", "warn");
    }
    const next = Number(user.wallet_tokens) + finalAmount;
    if (next < 0) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Token eksiye dusurulemez.", "err");
    }
    await client.query("UPDATE users SET wallet_tokens = $1 WHERE id = $2", [next, userId]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, treasure_id, amount, type, created_at)
       VALUES ($1, NULL, $2, 'admin_adjustment', $3)`,
      [userId, finalAmount, Date.now()]
    );
    await client.query("COMMIT");
    await logAdminAction(req.adminSession.adminId, "admin_token_adjustment", { userId, amount: finalAmount, reason, newBalance: next }, getIp(req));
    return redirectWithMsg(res, "/admin/tokens", "Token islemi basarili.");
  } catch (_e) {
    await client.query("ROLLBACK").catch(() => {});
    return redirectWithMsg(res, "/admin/tokens", "Token islemi basarisiz.", "err");
  } finally {
    client.release();
  }
});

router.post("/users/:id/tokens", requireAdminSession, async (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || "").trim();
  const redirectTo = String(req.body.redirectTo || `/admin/users/${userId}`);
  if (!Number.isFinite(userId) || !Number.isFinite(amount) || !reason) {
    return redirectWithMsg(res, redirectTo, "Gecersiz token duzenleme istegi.", "err");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query("SELECT id, wallet_tokens FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, redirectTo, "Kullanici bulunamadi.", "warn");
    }
    const next = Number(user.wallet_tokens) + amount;
    if (next < 0) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, redirectTo, "Token eksiye dusurulemez.", "err");
    }
    await client.query("UPDATE users SET wallet_tokens = $1 WHERE id = $2", [next, userId]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, treasure_id, amount, type, created_at)
       VALUES ($1, NULL, $2, 'admin_adjustment', $3)`,
      [userId, amount, Date.now()]
    );
    await client.query("COMMIT");
    await logAdminAction(req.adminSession.adminId, "admin_token_adjustment", { userId, amount, reason, newBalance: next }, getIp(req));
    return redirectWithMsg(res, redirectTo, "Token islemi basarili.");
  } catch (_e) {
    await client.query("ROLLBACK").catch(() => {});
    return redirectWithMsg(res, redirectTo, "Token islemi basarisiz.", "err");
  } finally {
    client.release();
  }
});

router.post("/users/:id/ban", requireAdminSession, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const redirectTo = String(req.body.redirectTo || `/admin/users/${userId}`);
    await db.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);
    await logAdminAction(req.adminSession.adminId, "admin_ban_user", { userId }, getIp(req));
    return redirectWithMsg(res, redirectTo, "Kullanici banlandi.", "warn");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/bans", "Ban islemi basarisiz.", "err");
  }
});

router.post("/users/:id/unban", requireAdminSession, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const redirectTo = String(req.body.redirectTo || `/admin/users/${userId}`);
    await db.query("UPDATE users SET is_banned = false WHERE id = $1", [userId]);
    await logAdminAction(req.adminSession.adminId, "admin_unban_user", { userId }, getIp(req));
    return redirectWithMsg(res, redirectTo, "Kullanici bani kaldirildi.");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/bans", "Unban islemi basarisiz.", "err");
  }
});

router.post("/users/ban-by-id", requireAdminSession, async (req, res) => {
  const userId = Number(req.body.userId);
  if (!Number.isFinite(userId)) return redirectWithMsg(res, "/admin/bans", "Gecersiz kullanici ID.", "err");
  try {
    await db.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);
    await logAdminAction(req.adminSession.adminId, "admin_ban_user", { userId }, getIp(req));
    return redirectWithMsg(res, "/admin/bans", "Kullanici banlandi.", "warn");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/bans", "Ban islemi basarisiz.", "err");
  }
});

router.post("/treasures/spawn", requireAdminSession, async (req, res) => {
  try {
    const redirectTo = String(req.body.redirectTo || "/admin/treasures");
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const type = String(req.body.type || "custom").slice(0, 40);
    const value = Number(req.body.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(value) || value < 0) {
      return redirectWithMsg(res, redirectTo, "Gecersiz hazine verisi.", "err");
    }
    const now = Date.now();
    const insert = await db.query(
      `INSERT INTO treasures (lat, lng, type, value, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id`,
      [lat, lng, type, value, now]
    );
    await logAdminAction(req.adminSession.adminId, "admin_treasure_spawn", { treasureId: insert.rows[0].id, lat, lng, type, value }, getIp(req));
    return redirectWithMsg(res, redirectTo, "Hazine olusturuldu.");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/treasures", "Hazine olusturma basarisiz.", "err");
  }
});

router.post("/treasures/:id/deactivate", requireAdminSession, async (req, res) => {
  try {
    const treasureId = Number(req.params.id);
    const redirectTo = String(req.body.redirectTo || "/admin/treasures");
    await db.query("UPDATE treasures SET status = 'inactive' WHERE id = $1 AND status = 'active'", [treasureId]);
    await logAdminAction(req.adminSession.adminId, "admin_treasure_deactivate", { treasureId }, getIp(req));
    return redirectWithMsg(res, redirectTo, "Aktif hazine kapatildi.", "warn");
  } catch (_e) {
    return redirectWithMsg(res, "/admin/treasures", "Hazine kapatma basarisiz.", "err");
  }
});

module.exports = router;
