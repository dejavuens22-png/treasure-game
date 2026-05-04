const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { db } = require("../db");

const router = express.Router();

const ADMIN_COOKIE = "admin_session";
const ADMIN_2FA_TEMP_COOKIE = "admin_2fa_temp";
const ADMIN_SETUP_PENDING_COOKIE = "admin_setup_pending";
const TWO_FA_PENDING_TTL_MS = 5 * 60 * 1000;
const SETUP_PENDING_TTL_MS = 15 * 60 * 1000;
const TWO_FA_MAX_FAILS = 5;
const TWO_FA_LOCK_MS = 5 * 60 * 1000;
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
  admin_login_password_success: "Admin sifre dogrulandi (2FA bekleniyor)",
  admin_login_password_failed: "Admin sifre hatali",
  admin_2fa_success: "Admin 2FA basarili",
  admin_2fa_failed: "Admin 2FA hatali",
  admin_2fa_locked: "Admin 2FA gecici kilit",
  admin_logout: "Admin cikis",
  admin_token_adjustment: "Token duzenleme",
  token_adjustment_request_created: "Token islem talebi olusturuldu",
  token_adjustment_approved: "Token islem talebi onaylandi",
  token_adjustment_rejected: "Token islem talebi reddedildi",
  token_adjustment_code_failed: "Token islem dogrulama kodu hatali",
  token_adjustment_signature_failed: "Token islem imza dogrulamasi basarisiz",
  token_adjustment_2fa_failed: "Token islem onayinda 2FA hatasi",
  admin_ban_user: "Kullanici banlama",
  admin_unban_user: "Kullanici ban kaldirma",
  admin_treasure_spawn: "Hazine olusturma",
  admin_treasure_deactivate: "Aktif hazineyi kapatma",
  blocked_unsafe_token_attempt: "Güvensiz token endpoint denemesi (engellendi)",
};

const TOKEN_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const DEV_TOKEN_SIGNING_FALLBACK = "dev-token-signing-secret-not-for-production";

const getTokenSigningSecret = () => {
  const raw = process.env.TOKEN_SIGNING_SECRET;
  if (raw != null && String(raw).trim() !== "") return String(raw);
  if (process.env.NODE_ENV === "production") return null;
  console.warn(`
================================================================================
[TOKEN_SIGNING_SECRET] EKSİK: Production dışında geçici anahtar kullanılıyor.
Render / production için mutlaka TOKEN_SIGNING_SECRET tanımlayın.
================================================================================
`);
  return DEV_TOKEN_SIGNING_FALLBACK;
};

const canonicalSignString = (targetUserId, adminId, amount, reason, createdAt) =>
  `${Number(targetUserId)}|${Number(adminId)}|${Number(amount)}|${String(reason)}|${Number(createdAt)}`;

const computeTokenRequestSignature = (targetUserId, adminId, amount, reason, createdAt) => {
  const secret = getTokenSigningSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(canonicalSignString(targetUserId, adminId, amount, reason, createdAt)).digest("hex");
};

const signaturesMatch = (expectedHex, actualHex) => {
  try {
    const a = Buffer.from(String(expectedHex || ""), "hex");
    const b = Buffer.from(String(actualHex || ""), "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_e) {
    return false;
  }
};

const expirePendingTokenRequests = async (clientOrPool, nowMs) => {
  const cutoff = nowMs - TOKEN_REQUEST_TTL_MS;
  await clientOrPool.query(
    `UPDATE token_adjustment_requests SET status = 'expired' WHERE status = 'pending' AND created_at < $1`,
    [cutoff]
  );
};

const requestStatusTr = (s) =>
  ({
    pending: "Bekliyor",
    approved: "Onaylandı",
    rejected: "Reddedildi",
    expired: "Süresi doldu",
  }[s] || s);

const generateSixDigitCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

const isTokenSigningSecretEnvMissing = () => {
  const s = process.env.TOKEN_SIGNING_SECRET;
  return s == null || String(s).trim() === "";
};

const cleanupExpired2faPending = async () =>
  db.query(`DELETE FROM admin_2fa_pending WHERE expires_at < $1`, [Date.now()]);

const cleanupExpiredSetupPending = async () =>
  db.query(`DELETE FROM admin_setup_pending WHERE expires_at < $1`, [Date.now()]);

const normalizeTotpInput = (v) => String(v || "").replace(/\s/g, "");

const verifyTotpOrNull = (secretBase32, sixDigitToken) => {
  if (!secretBase32 || !/^\d{6}$/.test(normalizeTotpInput(sixDigitToken))) return false;
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: "base32",
    token: normalizeTotpInput(sixDigitToken),
    window: 1,
  });
};

const createAdminSessionCookies = async (res, adminId, nowMs) => {
  const token = crypto.randomBytes(48).toString("hex");
  await db.query("INSERT INTO admin_sessions (admin_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
    adminId,
    token,
    nowMs,
    nowMs + SESSION_TTL_MS,
  ]);
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    expires: new Date(nowMs + SESSION_TTL_MS),
  });
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
    ["/admin/tokens", "Token Yönetimi"],
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
    <div class="topActions">
      ${current !== "/admin" ? `<a class="btn neutral" href="/admin">Ana Panele Don</a>` : ""}
      <form method="post" action="/admin/logout"><button class="btn danger">Cikis Yap</button></form>
    </div>
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
    .topActions { display:flex; align-items:center; gap:8px; margin-left:auto; }
    .navlink { color:#7dd3fc; border:1px solid #334155; padding:7px 10px; border-radius:9px; text-decoration:none; background:#111827; transition:all .16s ease; }
    .navlink:hover { border-color:#475569; background:#1a2437; transform:translateY(-1px); }
    .navlink.active { background:#1d4ed8; color:#dbeafe; border-color:#3b82f6; }
    .card { background:#111827; border:1px solid #334155; border-radius:12px; padding:16px; margin-bottom:14px; }
    .card h1, .card h2, .card h3, .card p { margin:0 0 10px; }
    .muted { color:#94a3b8; font-size:13px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .rowEnd { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:flex-end; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
    .menuGrid { display:grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .menuCard { display:block; border:1px solid #334155; border-radius:12px; background:#0b1220; color:#e2e8f0; text-decoration:none; padding:14px; transition:all .18s ease; }
    .menuCard:hover { transform:translateY(-3px); border-color:#475569; box-shadow:0 8px 16px rgba(2,6,23,.24); }
    .menuCard strong { display:block; margin-bottom:6px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { border:1px solid #334155; padding:7px; text-align:left; vertical-align:top; }
    th { background:#1f2937; }
    input, select, textarea, button { background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:8px; }
    button { cursor:pointer; }
    .btn {
      display:inline-flex; align-items:center; justify-content:center;
      height:34px; padding:0 12px; border-radius:8px; border:1px solid #334155;
      text-decoration:none; white-space:nowrap; font-size:12px; font-weight:700;
      transition:all .16s ease;
    }
    .btn:hover { transform:translateY(-1px); filter:brightness(1.08); }
    .good { background:#14532d; border-color:#166534; }
    .danger { background:#7f1d1d; border-color:#991b1b; }
    .warn { background:#78350f; border-color:#92400e; }
    .neutral { background:#1d4ed8; border-color:#2563eb; color:#dbeafe; }
    .subtle { background:#334155; border-color:#475569; color:#e2e8f0; }
    .flash { margin-bottom:10px; padding:10px; border-radius:8px; border:1px solid; }
    .flash.ok { background:#14532d; border-color:#166534; color:#bbf7d0; }
    .flash.err { background:#7f1d1d; border-color:#991b1b; color:#fecaca; }
    .flash.warn { background:#78350f; border-color:#92400e; color:#fde68a; }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; }
    .tableActions { display:flex; align-items:center; gap:8px; flex-wrap:nowrap; }
    .tableActions form { margin:0; }
    .tableActions .btn { height:30px; font-size:11px; padding:0 10px; }
    @media (max-width: 980px) {
      .tableActions { flex-wrap:wrap; }
      .topActions { width:100%; justify-content:flex-end; }
    }
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

const authWidePage = (title, body, flash = {}) => `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif}
.wrap{max-width:640px;margin:40px auto;padding:0 16px}
.card{background:#111827;border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:12px}
input,button{width:100%;box-sizing:border-box;margin-bottom:10px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:12px;font-size:16px}
button{cursor:pointer;background:#14532d;border-color:#166534;font-weight:700}
.secret{font-family:ui-monospace,monospace;word-break:break-all;background:#1e293b;padding:12px;border-radius:8px;border:1px solid #334155;font-size:13px;line-height:1.4;margin:12px 0}
.qr-wrap{display:flex;justify-content:center;margin:16px 0}
.qr{background:#fff;padding:10px;border-radius:10px;max-width:260px;width:100%;box-sizing:border-box}
.flash{margin-bottom:12px;padding:12px;border-radius:8px;border:1px solid;font-size:14px}
.flash.ok{background:#14532d;border-color:#166534;color:#bbf7d0}.flash.err{background:#7f1d1d;border-color:#991b1b;color:#fecaca}.flash.warn{background:#78350f;border-color:#92400e;color:#fde68a}
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

/** Güvensiz / bypass token uçları için 403; testlerde `router.respondBlockedUnsafeTokenAttempt`. */
const respondBlockedUnsafeTokenAttempt = async (req, res) => {
  const ip = getIp(req);
  const pathForLog = String(req.originalUrl || req.url || "").split("?")[0];
  const payload = JSON.stringify({
    event: "blocked_unsafe_token_attempt",
    path: pathForLog,
    method: req.method,
    admin_id: req.adminSession?.adminId ?? null,
    ip,
  });
  console.warn("blocked_unsafe_token_attempt", payload);
  try {
    await logAdminAction(
      req.adminSession?.adminId ?? null,
      "blocked_unsafe_token_attempt",
      { path: pathForLog, method: req.method },
      ip
    );
  } catch (_e) {
    console.warn("[blocked_unsafe_token_attempt] admin_logs yazılamadı:", _e?.message || _e);
  }
  res.status(403).type("txt").send("Forbidden: güvenli token akışı dışında bakiye güncellenemez.");
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
    if ((await getAdminCount()) > 0) return redirectWithMsg(res, "/admin/login", "Admin zaten oluşturulmuş.", "warn");
    await cleanupExpiredSetupPending();
    const pendToken = req.cookies?.[ADMIN_SETUP_PENDING_COOKIE];
    if (pendToken) {
      const ok = await db.query(`SELECT token FROM admin_setup_pending WHERE token = $1 AND expires_at > $2`, [
        pendToken,
        Date.now(),
      ]);
      if (ok.rows[0]) return res.redirect("/admin/setup/verify");
    }
    const body = `<div class="card">
      <h2>Admin Kurulumu</h2>
      <p class="muted">Önce kullanıcı adı ve şifreyi oluşturun. Ardından iki aşamalı doğrulama (TOTP / Google Authenticator) tanımlanacaktır.</p>
      <form method="post" action="/admin/setup">
        <input name="username" placeholder="Kullanıcı adı" autocomplete="username" required />
        <input name="password" type="password" placeholder="Şifre" autocomplete="new-password" required />
        <input name="passwordConfirm" type="password" placeholder="Şifre tekrar" autocomplete="new-password" required />
        <button>Devam Et</button>
      </form>
    </div>`;
    return res.send(authWidePage("Admin Kurulumu", body, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(authWidePage("Admin Kurulumu", "<div class='card'>Kurulum sayfası açılamadı.</div>", { kind: "err" }));
  }
});

router.post("/setup", async (req, res) => {
  const ip = getIp(req);
  try {
    if ((await getAdminCount()) > 0) return redirectWithMsg(res, "/admin/login", "Admin zaten mevcut.", "warn");
    await cleanupExpiredSetupPending();
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || "");
    if (!username || !password) {
      return res.status(400).send(authWidePage("Admin Kurulumu", "<div class='card'>Kullanıcı adı ve şifre zorunlu.</div>", { kind: "err" }));
    }
    if (password.length < 6) {
      return res.status(400).send(authWidePage("Admin Kurulumu", "<div class='card'>Şifre en az 6 karakter olmalı.</div>", { kind: "err" }));
    }
    if (password !== passwordConfirm) {
      return res.status(400).send(authWidePage("Admin Kurulumu", "<div class='card'>Şifreler eşleşmiyor.</div>", { kind: "err" }));
    }
    const dup = await db.query("SELECT 1 FROM admin_users WHERE username = $1", [username]);
    if (dup.rows[0]) {
      return res.status(409).send(authWidePage("Admin Kurulumu", "<div class='card'>Bu kullanıcı adı kullanılıyor.</div>", { kind: "err" }));
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const totp = speakeasy.generateSecret({
      name: username,
      issuer: "TreasureAdmin",
      length: 20,
      symbols: false,
    });
    const pendToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();

    await db.query(`DELETE FROM admin_setup_pending WHERE username = $1`, [username]);
    await db.query(
      `INSERT INTO admin_setup_pending (token, username, password_hash, totp_secret, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [pendToken, username, passwordHash, totp.base32, now, now + SETUP_PENDING_TTL_MS]
    );

    res.cookie(ADMIN_SETUP_PENDING_COOKIE, pendToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SETUP_PENDING_TTL_MS,
      expires: new Date(now + SETUP_PENDING_TTL_MS),
    });

    await logAdminAction(null, "admin_setup", { step: "totp_offer", username }, ip);
    return res.redirect("/admin/setup/verify");
  } catch (err) {
    if (err.code === "23505") return res.status(409).send(authWidePage("Admin Kurulumu", "<div class='card'>Bu kullanıcı adı kullanılıyor.</div>", { kind: "err" }));
    console.error("[admin/setup]", err);
    return res.status(500).send(authWidePage("Admin Kurulumu", "<div class='card'>Kurulum adımı başarısız.</div>", { kind: "err" }));
  }
});

router.get("/setup/verify", async (req, res) => {
  try {
    if ((await getAdminCount()) > 0) {
      res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
      return redirectWithMsg(res, "/admin/login", "Admin zaten var.", "warn");
    }
    await cleanupExpiredSetupPending();
    const pendToken = req.cookies?.[ADMIN_SETUP_PENDING_COOKIE];
    if (!pendToken) {
      return redirectWithMsg(res, "/admin/setup", "Kurulum oturumu yok veya süresi doldu. Baştan başlayın.", "warn");
    }
    const row = (
      await db.query(`SELECT username, totp_secret FROM admin_setup_pending WHERE token = $1 AND expires_at > $2`, [
        pendToken,
        Date.now(),
      ])
    ).rows[0];
    if (!row) {
      res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
      return redirectWithMsg(res, "/admin/setup", "Kurulum oturumu yok veya süresi doldu.", "warn");
    }

    const otpauth = speakeasy.otpauthURL({
      secret: row.totp_secret,
      encoding: "base32",
      label: row.username,
      issuer: "TreasureAdmin",
    });
    let qrSvg = "";
    try {
      qrSvg = await QRCode.toDataURL(otpauth, { width: 220, margin: 1 });
    } catch (e) {
      console.error("[setup qr]", e);
    }

    const body = `<div class="card">
      <h2>İki Aşamalı Doğrulama (Kurulum)</h2>
      <p>Mobil uygulamanızdan <strong>Google Authenticator</strong> veya <strong>Authy</strong> ile QR kodunu okutun veya anahtarı elle girin. Ardından 6 haneli kodu yazın.</p>
      ${qrSvg ? `<div class="qr-wrap"><img class="qr" src="${qrSvg}" alt="TOTP QR" /></div>` : ""}
      <p><strong>Manuel anahtar (base32):</strong></p><div class="secret">${esc(row.totp_secret)}</div>
      <form method="post" action="/admin/setup/verify">
        <label class="muted" style="display:block;margin-bottom:6px;font-size:14px;color:#94a3b8;">6 haneli doğrulama kodu</label>
        <input name="totp_code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" required placeholder="000000" />
        <button>Admin Hesabını Oluştur</button>
      </form>
    </div>
    <p class="muted" style="margin-top:8px;text-align:center;font-size:13px;">Kodu doğru girmeden sistemde admin oluşturulmaz.</p>`;
    return res.send(authWidePage("Admin — TOTP Kurulum", body, getFlash(req)));
  } catch (e) {
    console.error("[admin/setup/verify get]", e);
    return res.status(500).send(authWidePage("Kurulum", "<div class='card'>Sayfa yüklenemedi.</div>", { kind: "err" }));
  }
});

router.post("/setup/verify", async (req, res) => {
  const ip = getIp(req);
  try {
    if ((await getAdminCount()) > 0) {
      res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
      return redirectWithMsg(res, "/admin/login", "Admin zaten var.", "warn");
    }
    await cleanupExpiredSetupPending();
    const pendToken = req.cookies?.[ADMIN_SETUP_PENDING_COOKIE];
    if (!pendToken) {
      return redirectWithMsg(res, "/admin/setup", "Kurulum oturumu yok.", "warn");
    }
    const row = (
      await db.query(
        `SELECT username, password_hash, totp_secret FROM admin_setup_pending WHERE token = $1 AND expires_at > $2`,
        [pendToken, Date.now()]
      )
    ).rows[0];
    if (!row) {
      res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
      return redirectWithMsg(res, "/admin/setup", "Kurulum oturumu yok veya süresi doldu.", "warn");
    }

    const ok = verifyTotpOrNull(row.totp_secret, req.body.totp_code);
    if (!ok) {
      return redirectWithMsg(res, "/admin/setup/verify", "Geçersiz kod. Tekrar deneyin.", "err");
    }

    const now = Date.now();
    try {
      const ins = await db.query(
        `INSERT INTO admin_users (username, password_hash, totp_secret, totp_enabled, totp_fail_count, totp_locked_until, created_at)
         VALUES ($1, $2, $3, true, 0, NULL, $4) RETURNING id`,
        [row.username, row.password_hash, row.totp_secret, now]
      );
      await db.query(`DELETE FROM admin_setup_pending WHERE token = $1`, [pendToken]);
      res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
      await logAdminAction(ins.rows[0]?.id ?? null, "admin_setup", { username: row.username, totpActivated: true }, ip);
      return redirectWithMsg(res, "/admin/login", "Admin oluşturuldu. Güvenlik için çıkış yaptınız varsayılıyor; girişte 2FA kullanın.", "ok");
    } catch (err) {
      if (err.code === "23505") {
        return redirectWithMsg(res, "/admin/login", "Bu kullanıcı adı oluşturulmuş olabilir. Giriş deneyin.", "warn");
      }
      console.error("[admin/setup/verify post]", err);
      return redirectWithMsg(res, "/admin/setup/verify", "Veritabanı hatası. Tekrar deneyin.", "err");
    }
  } catch (e) {
    console.error("[admin/setup/verify post outer]", e);
    return redirectWithMsg(res, "/admin/setup", "Kurulum tamamlanamadı.", "err");
  }
});

router.get("/login", async (req, res) => {
  try {
    if ((await getAdminCount()) === 0) return res.redirect("/admin/setup");
    if (await getSessionFromRequest(req)) return res.redirect("/admin");
    const temp = req.cookies?.[ADMIN_2FA_TEMP_COOKIE];
    if (temp) {
      const still = (
        await db.query(`SELECT 1 FROM admin_2fa_pending WHERE token = $1 AND expires_at > $2`, [temp, Date.now()])
      ).rows[0];
      if (still) return res.redirect("/admin/verify-2fa");
    }
    const body = `<div class="card">
      <h2>Giriş</h2>
      <p class="muted">İlk adımda kullanıcı adı ve şifre, ardından 6 haneli TOTP doğrulanır.</p>
      <form method="post" action="/admin/login">
        <input name="username" placeholder="Kullanıcı adı" autocomplete="username" required />
        <input name="password" type="password" placeholder="Şifre" autocomplete="current-password" required />
        <button>Devam</button>
      </form>
    </div>`;
    return res.send(authWidePage("Admin Girişi", body, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(authWidePage("Admin Giriş", "<div class='card'>Giriş sayfası açılamadı.</div>", { kind: "err" }));
  }
});

router.post("/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const ip = getIp(req);
  try {
    await cleanupExpired2faPending();
    res.clearCookie(ADMIN_2FA_TEMP_COOKIE);

    if (!username || !password) {
      return res.status(400).send(authWidePage("Admin Giriş", "<div class='card'>Kullanıcı adı ve şifre zorunlu.</div>", { kind: "err" }));
    }

    const adminResult = await db.query(
      `SELECT id, username, password_hash, totp_secret, totp_enabled, totp_locked_until, totp_fail_count
       FROM admin_users WHERE username = $1`,
      [username]
    );
    const admin = adminResult.rows[0];

    const failPw = async () => {
      await logAdminAction(admin?.id ?? null, "admin_login_password_failed", { username }, ip);
      return res.status(401).send(authWidePage("Admin Giriş", "<div class='card'>Kullanıcı adı veya şifre hatalı.</div>", { kind: "err" }));
    };

    if (!admin) return failPw();

    const lockedUntil = Number(admin.totp_locked_until || 0);
    if (lockedUntil > Date.now()) {
      const body = `<div class='card'><h2>Erişim geçici kilitli</h2>
        <p>Çok fazla hatalı iki aşamalı doğrulama denemesi. <strong>5 dakika</strong> sonra tekrar deneyin.</p>
        <p class="muted">Kilit bitişi: ${esc(fmtTime(lockedUntil))}</p>
        <a href="/admin/login" style="display:inline-block;margin-top:12px;color:#7dd3fc;">Girişe dön</a></div>`;
      return res.status(429).send(authWidePage("Kilitli", body, { kind: "err", message: "" }));
    }

    if (!(await bcrypt.compare(password, admin.password_hash))) return failPw();

    await logAdminAction(admin.id, "admin_login_password_success", { username: admin.username }, ip);

    const needsEnroll = !admin.totp_secret || !admin.totp_enabled;
    const now = Date.now();
    const pendToken = crypto.randomBytes(32).toString("hex");

    if (needsEnroll) {
      const totp = speakeasy.generateSecret({
        name: admin.username,
        issuer: "TreasureAdmin",
        length: 20,
        symbols: false,
      });
      await db.query(`DELETE FROM admin_2fa_pending WHERE admin_id = $1`, [admin.id]);
      await db.query(
        `INSERT INTO admin_2fa_pending (token, admin_id, kind, enroll_totp_secret, created_at, expires_at)
         VALUES ($1, $2, 'first_enroll', $3, $4, $5)`,
        [pendToken, admin.id, totp.base32, now, now + TWO_FA_PENDING_TTL_MS]
      );
    } else {
      await db.query(`DELETE FROM admin_2fa_pending WHERE admin_id = $1`, [admin.id]);
      await db.query(
        `INSERT INTO admin_2fa_pending (token, admin_id, kind, enroll_totp_secret, created_at, expires_at)
         VALUES ($1, $2, 'login_2fa', NULL, $3, $4)`,
        [pendToken, admin.id, now, now + TWO_FA_PENDING_TTL_MS]
      );
    }

    res.cookie(ADMIN_2FA_TEMP_COOKIE, pendToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: TWO_FA_PENDING_TTL_MS,
      expires: new Date(now + TWO_FA_PENDING_TTL_MS),
    });

    return res.redirect("/admin/verify-2fa");
  } catch (e) {
    console.error("[admin/login]", e);
    return res.status(500).send(authWidePage("Admin Giriş", "<div class='card'>Giriş başarısız.</div>", { kind: "err" }));
  }
});

router.get("/verify-2fa", async (req, res) => {
  await cleanupExpired2faPending();
  const raw = req.cookies?.[ADMIN_2FA_TEMP_COOKIE];
  if (!raw) {
    return redirectWithMsg(res, "/admin/login", "Geçici oturum bulunamadı. Tekrar kullanıcı adı ve şifre girin.", "warn");
  }
  try {
    const row = (
      await db.query(
        `SELECT p.kind, p.enroll_totp_secret, p.admin_id, u.username, u.totp_locked_until, u.totp_secret, u.totp_enabled
         FROM admin_2fa_pending p
         JOIN admin_users u ON u.id = p.admin_id
         WHERE p.token = $1 AND p.expires_at > $2`,
        [raw, Date.now()]
      )
    ).rows[0];
    if (!row) {
      res.clearCookie(ADMIN_2FA_TEMP_COOKIE);
      return redirectWithMsg(res, "/admin/login", "Geçici oturum süresi doldu. Tekrar giriş yapın.", "warn");
    }

    const lockedUntil = Number(row.totp_locked_until || 0);
    if (lockedUntil > Date.now()) {
      const body = `<div class='card'><h2>Erişim geçici kilitli</h2>
        <p>Çok fazla hatalı deneme nedeniyle 5 dakika beklemeniz gerekir.</p>
        <p class="muted">Kilit bitişi: ${esc(fmtTime(lockedUntil))}</p></div>`;
      return res.status(429).send(authWidePage("Kilitli", body, {}));
    }

    let extra = "";
    if (row.kind === "first_enroll") {
      const otpauth = speakeasy.otpauthURL({
        secret: row.enroll_totp_secret,
        encoding: "base32",
        label: row.username,
        issuer: "TreasureAdmin",
      });
      let qrSvg = "";
      try {
        qrSvg = await QRCode.toDataURL(otpauth, { width: 220, margin: 1 });
      } catch (_e) {
        /**/
      }
      extra = `
        <div class='card'><h3>Authenticator kurulumu (bir kez)</h3>
        <p>Hesabınızda henüz 2FA kayıtlı değil. Uygulamaya bu QR veya elle anahtarı ekleyip ardından üretilen 6 haneyi girin.</p>
        ${qrSvg ? `<div class='qr-wrap'><img class='qr' src='${qrSvg}' alt='TOTP QR' /></div>` : ""}
        <p><strong>Manuel anahtar:</strong></p><div class='secret'>${esc(row.enroll_totp_secret)}</div></div>`;
    }

    const title = row.kind === "first_enroll" ? "Authenticator kaydı" : "2 Aşamalı doğrulama";
    const body = `${extra}
      <div class="card">
        <h2>2 Aşamalı Doğrulama</h2>
        <p class="muted">Google Authenticator veya Authy uygulamasındaki 6 haneli kodu girin.</p>
        <form method="post" action="/admin/verify-2fa">
          <input name="totp_code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" required />
          <button>Oturumu Aç</button>
        </form>
        <p style="margin-top:12px;font-size:13px;"><a href="/admin/login" style="color:#7dd3fc;">← Şifre ekranına dön</a></p>
      </div>`;
    return res.send(authWidePage(title, body, getFlash(req)));
  } catch (e) {
    console.error("[verify-2fa get]", e);
    return res.status(500).send(authWidePage("Hata", "<div class='card'>Doğrulama sayfası açılamadı.</div>", { kind: "err" }));
  }
});

router.post("/verify-2fa", async (req, res) => {
  const ip = getIp(req);
  await cleanupExpired2faPending();
  const raw = req.cookies?.[ADMIN_2FA_TEMP_COOKIE];
  if (!raw) {
    return redirectWithMsg(res, "/admin/login", "Geçici oturum yok. Tekrar giriş yapın.", "warn");
  }

  try {
    const pend = (
      await db.query(
        `SELECT p.token, p.kind, p.enroll_totp_secret, p.admin_id, u.username, u.totp_locked_until, u.totp_fail_count,
                u.totp_secret AS user_totp_secret, u.totp_enabled
         FROM admin_2fa_pending p
         JOIN admin_users u ON u.id = p.admin_id
         WHERE p.token = $1 AND p.expires_at > $2`,
        [raw, Date.now()]
      )
    ).rows[0];

    if (!pend) {
      res.clearCookie(ADMIN_2FA_TEMP_COOKIE);
      return redirectWithMsg(res, "/admin/login", "Geçici oturum geçersiz veya süresi doldu.", "warn");
    }

    const lockedUntil = Number(pend.totp_locked_until || 0);
    if (lockedUntil > Date.now()) {
      return redirectWithMsg(
        res,
        "/admin/verify-2fa",
        "Çok fazla hatalı deneme. Lütfen bekleyip tekrar deneyin.",
        "warn"
      );
    }

    const secretToCheck = pend.kind === "first_enroll" ? pend.enroll_totp_secret : pend.user_totp_secret;
    const codeOk = verifyTotpOrNull(secretToCheck, req.body.totp_code);
    const now = Date.now();

    if (!codeOk) {
      const fails = Number(pend.totp_fail_count || 0) + 1;

      if (fails >= TWO_FA_MAX_FAILS) {
        const until = now + TWO_FA_LOCK_MS;
        await db.query(
          `UPDATE admin_users SET totp_fail_count = 0, totp_locked_until = $1 WHERE id = $2`,
          [until, pend.admin_id]
        );
        await logAdminAction(pend.admin_id, "admin_2fa_locked", { fails: TWO_FA_MAX_FAILS, until }, ip);
        await db.query(`DELETE FROM admin_2fa_pending WHERE token = $1`, [pend.token]);
        res.clearCookie(ADMIN_2FA_TEMP_COOKIE);
        return redirectWithMsg(
          res,
          "/admin/login",
          "Çok fazla hatalı 2FA denemesi; 5 dakika bekleyin.",
          "err"
        );
      }

      await db.query(`UPDATE admin_users SET totp_fail_count = $1 WHERE id = $2`, [fails, pend.admin_id]);
      await logAdminAction(pend.admin_id, "admin_2fa_failed", { attempts: fails }, ip);
      return redirectWithMsg(res, "/admin/verify-2fa", `Geçersiz kod (${fails}/${TWO_FA_MAX_FAILS}).`, "err");
    }

    if (pend.kind === "first_enroll") {
      await db.query(
        `UPDATE admin_users SET totp_secret = $2, totp_enabled = true, totp_fail_count = 0, totp_locked_until = NULL WHERE id = $1`,
        [pend.admin_id, pend.enroll_totp_secret]
      );
    } else {
      await db.query(
        `UPDATE admin_users SET totp_fail_count = 0, totp_locked_until = NULL WHERE id = $1`,
        [pend.admin_id]
      );
    }

    await db.query(`DELETE FROM admin_2fa_pending WHERE token = $1`, [pend.token]);
    res.clearCookie(ADMIN_2FA_TEMP_COOKIE);

    await createAdminSessionCookies(res, pend.admin_id, now);
    await logAdminAction(pend.admin_id, "admin_2fa_success", { username: pend.username, enrolled: pend.kind === "first_enroll" }, ip);

    return res.redirect("/admin");
  } catch (e) {
    console.error("[verify-2fa post]", e);
    return redirectWithMsg(res, "/admin/login", "Doğrulama sırasında hata oluştu.", "err");
  }
});

router.post("/logout", requireAdminSession, async (req, res) => {
  try {
    await db.query("DELETE FROM admin_sessions WHERE token = $1", [req.adminSession.token]);
    res.clearCookie(ADMIN_COOKIE);
    res.clearCookie(ADMIN_2FA_TEMP_COOKIE);
    res.clearCookie(ADMIN_SETUP_PENDING_COOKIE);
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
      ["/admin/users", "Kayıtlı Oyuncular", "Oyuncu listesi, detay ve arama", "👥"],
      ["/admin/tokens", "Token Yönetimi", "Token ekleme/silme islemleri", "🪙"],
      ["/admin/bans", "Ban Yönetimi", "Banli oyuncular ve ban islemleri", "⛔"],
      ["/admin/suspicious", "Şüpheli Hareketler", "Supheli olaylari filtrele ve incele", "⚠️"],
      ["/admin/treasures", "Hazine Yönetimi", "Aktif hazine ve manuel olusturma", "💰"],
      ["/admin/avatars", "Avatar Ekonomisi", "Avatar fiyat tablosu", "🧩"],
      ["/admin/logs", "Admin İşlem Kayıtları", "Admin aksiyon gecmisi", "🧾"],
    ]
      .map(
        ([href, title, desc, icon]) =>
          `<a class="menuCard" href="${href}"><strong>${esc(icon)} ${esc(title)}</strong><span class="muted">${esc(desc)}</span></a>`
      )
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
          <td class="tableActions">
            <a class="btn neutral" href="/admin/users/${u.id}">Detay Gor</a>
            <a class="btn neutral" href="/admin/tokens?userId=${u.id}">Talep Olustur</a>
            ${
              u.is_banned
                ? `<form method="post" action="/admin/users/${u.id}/unban"><input type="hidden" name="redirectTo" value="/admin/users" /><button class="btn good">Bani Kaldir</button></form>`
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
          <button class="btn neutral">Ara</button>
          <a class="btn neutral" href="/admin/users">Temizle</a>
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
      <div class="card"><div class="rowEnd">
        <a class="btn neutral" href="/admin/tokens?userId=${user.id}">Talep Olustur</a>
        ${
          user.is_banned
            ? `<form method="post" action="/admin/users/${user.id}/unban"><input type="hidden" name="redirectTo" value="/admin/users/${user.id}" /><button class="btn good">Bani Kaldir</button></form>`
            : `<form method="post" action="/admin/users/${user.id}/ban"><input type="hidden" name="redirectTo" value="/admin/users/${user.id}" /><button class="btn danger">Banla</button></form>`
        }
        <a class="btn neutral" href="/admin/users">Geri Don</a>
      </div></div>
      <div class="card"><h3>Supheli Hareketler</h3><table><thead><tr><th>ID</th><th>Tip</th><th>Mesaj</th><th>Metadata</th><th>Tarih</th></tr></thead><tbody>${suspiciousRows || "<tr><td colspan='5'>Kayit yok.</td></tr>"}</tbody></table></div>
      <div class="card"><h3>Son 20 Wallet Islemi</h3><table><thead><tr><th>ID</th><th>Miktar</th><th>Tip</th><th>Treasure ID</th><th>Tarih</th></tr></thead><tbody>${txRows || "<tr><td colspan='5'>Islem yok.</td></tr>"}</tbody></table></div>`;
    return res.send(page("Oyuncu Detayi", "/admin/users", content, getFlash(req)));
  } catch (_e) {
    return res.status(500).send(page("Oyuncu Detayi", "/admin/users", "<div class='card'>Detay sayfasi yuklenemedi.</div>", { kind: "err", message: "Sunucu hatasi." }));
  }
});

const renderTokensPage = async (req, res, extra = {}) => {
  try {
    const now = Date.now();
    await expirePendingTokenRequests(db, now);

    const [pendingResult, historyResult] = await Promise.all([
      db.query(
        `SELECT r.id, r.target_user_id, r.amount, r.reason, r.created_at,
                u.username AS target_username,
                a.username AS admin_username
         FROM token_adjustment_requests r
         JOIN users u ON u.id = r.target_user_id
         JOIN admin_users a ON a.id = r.admin_id
         WHERE r.status = 'pending'
         ORDER BY r.created_at DESC`
      ),
      db.query(
        `SELECT r.id, r.target_user_id, r.amount, r.reason, r.status, r.created_at, r.approved_at, r.rejected_at,
                u.username AS target_username,
                a.username AS admin_username
         FROM token_adjustment_requests r
         JOIN users u ON u.id = r.target_user_id
         JOIN admin_users a ON a.id = r.admin_id
         WHERE r.status IN ('approved', 'rejected', 'expired')
         ORDER BY COALESCE(r.approved_at, r.rejected_at, r.created_at) DESC
         LIMIT 50`
      ),
    ]);

    const qPrefill =
      String(req.query.target_user_id || req.query.user_id || req.query.userId || "").trim() ||
      (extra.prefillTargetUserId != null ? String(extra.prefillTargetUserId) : "");
    const amountPlaceholder = "Pozitif ekler, negatif çıkarır (ör. 100 veya -50)";

    const codeBox =
      extra.codeReveal && String(extra.codeReveal).length === 6
        ? `<div class="flash warn" style="font-size:15px;line-height:1.45;">
            <strong>Doğrulama kodu: ${esc(extra.codeReveal)}</strong><br/>
            Bu kod yalnızca bu yanıtta görünür; güvenli bir yere yazın.
            <strong>Bu kod tekrar gösterilmez.</strong> Sayfa yenilenirse görünmez (yalnızca hash saklanır).
          </div>`
        : "";

    const signingBanner = isTokenSigningSecretEnvMissing()
      ? `<div class="flash err" style="font-size:15px;line-height:1.45;">
          <strong>TOKEN_SIGNING_SECRET tanımlı değil.</strong>
          Production ortamında token işlemleri güvenli değildir.
          Hosting panelinde uzun bir sır değişkeni tanımlayın (ör. Render Environment).
        </div>`
      : "";

    const pendingRows = pendingResult.rows
      .map(
        (r) => `<tr>
          <td>${r.id}</td>
          <td>#${r.target_user_id} ${esc(r.target_username)}</td>
          <td>${r.amount > 0 ? "+" : ""}${r.amount}</td>
          <td>${esc(r.reason)}</td>
          <td>${esc(r.admin_username)}</td>
          <td>${fmtTime(r.created_at)}</td>
          <td>
            <form method="post" action="/admin/tokens/${r.id}/approve" style="margin:0;display:flex;flex-direction:column;gap:6px;max-width:200px;">
              <span class="muted" style="font-size:11px;">Talep doğrulama kodu</span>
              <input name="verification_code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Tek seferlik kod" required style="width:100%;box-sizing:border-box;" />
              <span class="muted" style="font-size:11px;">Authenticator (2FA) kodunuz</span>
              <input name="totp_code" type="text" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="Google Authenticator" required style="width:100%;box-sizing:border-box;" />
              <button type="submit" class="btn good">Onayla</button>
            </form>
          </td>
          <td>
            <form method="post" action="/admin/tokens/${r.id}/reject" style="margin:0;">
              <button type="submit" class="btn danger">Reddet</button>
            </form>
          </td>
        </tr>`
      )
      .join("");

    const historyRows = historyResult.rows
      .map(
        (r) => `<tr>
          <td>${r.id}</td>
          <td>#${r.target_user_id} ${esc(r.target_username)}</td>
          <td>${r.amount > 0 ? "+" : ""}${r.amount}</td>
          <td>${esc(r.reason)}</td>
          <td>${esc(requestStatusTr(r.status))}</td>
          <td>${esc(r.admin_username)}</td>
          <td>${fmtTime(r.created_at)}</td>
          <td>${fmtTime(r.approved_at || r.rejected_at)}</td>
        </tr>`
      )
      .join("");

    const flash = extra.flashOverride !== undefined ? extra.flashOverride : getFlash(req);
    const content = `
      ${signingBanner}
      <div class="card">
        <h1>Token Yönetimi</h1>
        <p class="muted">Token bakiyesi değişiklikleri talep ve doğrulama kodu ile yapılır. Tek tıkla doğrudan bakiye değişmez.</p>
        <div class="row" style="margin-top:10px;">
          <a class="btn subtle" href="/admin">Ana Panele Don</a>
        </div>
      </div>
      ${codeBox}
      <div class="card">
        <h2>Yeni Token İşlem Talebi</h2>
        <p class="muted">Token işlemleri önce bekleyen talep olarak oluşturulur; sistem tek kullanımlık doğrulama kodu üretir. Kod doğru girilmeden bakiye değişmez.</p>
        <p class="muted" style="margin-top:6px;"><strong>Güvenlik:</strong> Talep oluşturduğunuz yanıtta gösterilen doğrulama kodu bir kez gösterilir — sayfa yenilenir veya başka sekmede açırsanız kod tekrar görünmez. Bu kod DB’de yalnızca hash olarak saklanır.</p>
        <form method="post" action="/admin/tokens/request" class="row" style="flex-direction:column;align-items:stretch;max-width:520px;">
          <label class="muted">Kullanıcı ID</label>
          <input type="number" name="target_user_id" placeholder="Hedef oyuncu ID" value="${esc(qPrefill)}" required />
          <label class="muted">Miktar</label>
          <input type="number" name="amount" placeholder="${esc(amountPlaceholder)}" required />
          <label class="muted">Sebep</label>
          <textarea name="reason" rows="3" placeholder="İşlem sebebi (zorunlu)" required></textarea>
          <div class="row" style="margin-top:6px;">
            <button type="submit" class="btn neutral">Talep Olustur</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>Bekleyen Token İşlemleri</h2>
        <table>
          <thead><tr>
            <th>Talep ID</th><th>Kullanıcı</th><th>Miktar</th><th>Sebep</th><th>Oluşturan admin</th><th>Tarih</th><th>Talep kodu + 2FA ile onayla</th><th>Reddet</th>
          </tr></thead>
          <tbody>${pendingRows || "<tr><td colspan='8'>Bekleyen talep yok.</td></tr>"}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Son Token İşlemleri</h2>
        <p class="muted">Onaylanan, reddedilen veya süresi dolan talepler (son 50).</p>
        <table>
          <thead><tr>
            <th>Talep ID</th><th>Kullanıcı</th><th>Miktar</th><th>Sebep</th><th>Durum</th><th>Oluşturan admin</th><th>Talep tarihi</th><th>İşlem tarihi</th>
          </tr></thead>
          <tbody>${historyRows || "<tr><td colspan='8'>Kayit yok.</td></tr>"}</tbody>
        </table>
      </div>`;
    return res.send(page("Token Yönetimi", "/admin/tokens", content, flash));
  } catch (err) {
    console.error("[admin/tokens page]", err);
    return res
      .status(500)
      .send(page("Token Yönetimi", "/admin/tokens", "<div class='card'>Sayfa yüklenemedi.</div>", { kind: "err", message: "Sunucu hatası." }));
  }
};

router.get("/tokens", requireAdminSession, (req, res) => renderTokensPage(req, res));

router.post("/tokens/request", requireAdminSession, async (req, res) => {
  const targetUserId = Number(req.body.target_user_id);
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || "").trim();
  const ip = getIp(req);

  if (!Number.isFinite(targetUserId) || !Number.isInteger(amount) || amount === 0 || !reason) {
    return redirectWithMsg(res, "/admin/tokens", "Gecersiz talep: kullanici ID, sifirdan farkli tam sayi miktar ve sebep zorunlu.", "err");
  }

  const userResult = await db.query("SELECT id, wallet_tokens FROM users WHERE id = $1", [targetUserId]);
  const target = userResult.rows[0];
  if (!target) {
    return redirectWithMsg(res, "/admin/tokens", "Hedef kullanici bulunamadi.", "warn");
  }

  const nextPreview = Number(target.wallet_tokens) + amount;
  if (nextPreview < 0) {
    return redirectWithMsg(
      res,
      "/admin/tokens",
      "Bu miktar ile kullanicinin bakiyesi eksiye dusucegi icin talep olusturulamaz.",
      "err"
    );
  }

  const createdAt = Date.now();
  const signedPayload = computeTokenRequestSignature(targetUserId, req.adminSession.adminId, amount, reason, createdAt);
  if (!signedPayload) {
    return redirectWithMsg(
      res,
      "/admin/tokens",
      "TOKEN_SIGNING_SECRET yapilandirilmamis. Talep olusturulamadi.",
      "err"
    );
  }

  const plainCode = generateSixDigitCode();
  const verificationCodeHash = await bcrypt.hash(plainCode, 10);

  try {
    await db.query(
      `INSERT INTO token_adjustment_requests
        (target_user_id, admin_id, amount, reason, status, verification_code_hash, signed_payload, ip_address, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)`,
      [targetUserId, req.adminSession.adminId, amount, reason, verificationCodeHash, signedPayload, ip, createdAt]
    );
    await logAdminAction(
      req.adminSession.adminId,
      "token_adjustment_request_created",
      { targetUserId, amount, reason },
      ip
    );
  } catch (err) {
    console.error("[admin/tokens/request]", err);
    return redirectWithMsg(res, "/admin/tokens", "Talep kaydedilemedi.", "err");
  }

  return renderTokensPage(req, res, { codeReveal: plainCode, flashOverride: {}, prefillTargetUserId: "" });
});

router.post("/tokens/:requestId/approve", requireAdminSession, async (req, res) => {
  const requestId = Number(req.params.requestId);
  const verificationCode = String(req.body.verification_code || "").replace(/\s/g, "");
  const totpForApprove = normalizeTotpInput(req.body.totp_code);
  const ip = getIp(req);

  await expirePendingTokenRequests(db, Date.now());

  if (!Number.isFinite(requestId)) {
    return redirectWithMsg(res, "/admin/tokens", "Gecersiz talep kimligi.", "err");
  }

  const prodSecretMissing =
    process.env.NODE_ENV === "production" &&
    (process.env.TOKEN_SIGNING_SECRET == null || String(process.env.TOKEN_SIGNING_SECRET).trim() === "");
  if (prodSecretMissing) {
    return redirectWithMsg(
      res,
      "/admin/tokens",
      "Uretim ortaminda TOKEN_SIGNING_SECRET tanimlanmamis. Talep onaylanamaz.",
      "err"
    );
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const reqResult = await client.query(`SELECT * FROM token_adjustment_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const adj = reqResult.rows[0];

    if (!adj) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Talep bulunamadi.", "warn");
    }

    const now = Date.now();
    if (adj.status === "pending" && adj.created_at < now - TOKEN_REQUEST_TTL_MS) {
      await client.query(`UPDATE token_adjustment_requests SET status = 'expired' WHERE id = $1`, [requestId]);
      await client.query("COMMIT");
      return redirectWithMsg(res, "/admin/tokens", "Bu talebin suresi dolmus.", "warn");
    }

    if (adj.status !== "pending") {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Bu talep bekleyen durumda degil; tekrar onaylanamaz.", "warn");
    }

    if (!/^\d{6}$/.test(verificationCode)) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_code_failed", { requestId }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Dogru formatta 6 haneli kod girin.", "err");
    }

    const codeOk = await bcrypt.compare(verificationCode, adj.verification_code_hash);
    if (!codeOk) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_code_failed", { requestId }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Dogrulama kodu hatali.", "err");
    }

    if (!/^\d{6}$/.test(totpForApprove)) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_2fa_failed", { requestId, reason: "totp_missing_or_invalid_format" }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Authenticator (TOTP) kodu 6 hane olmalidir.", "err");
    }

    const admTotpRow = (
      await client.query(`SELECT totp_secret, totp_enabled FROM admin_users WHERE id = $1`, [req.adminSession.adminId])
    ).rows[0];
    if (!admTotpRow?.totp_secret || !admTotpRow.totp_enabled) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_2fa_failed", { requestId, reason: "totp_not_configured" }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Authenticator (2FA) hesabınızda etkin değil.", "err");
    }
    if (!verifyTotpOrNull(admTotpRow.totp_secret, totpForApprove)) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_2fa_failed", { requestId }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Authenticator (TOTP) kodunuz yanlış; bakiye güncellenmedi.", "err");
    }

    const expectedSig = computeTokenRequestSignature(
      adj.target_user_id,
      adj.admin_id,
      adj.amount,
      adj.reason,
      adj.created_at
    );
    if (!expectedSig || !signaturesMatch(adj.signed_payload, expectedSig)) {
      await client.query("ROLLBACK");
      await logAdminAction(req.adminSession.adminId, "token_adjustment_signature_failed", { requestId }, ip);
      return redirectWithMsg(res, "/admin/tokens", "Imza dogrulamasi basarisiz; islem iptal.", "err");
    }

    const userResult = await client.query(`SELECT id, wallet_tokens FROM users WHERE id = $1 FOR UPDATE`, [adj.target_user_id]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Hedef oyuncu bulunamadi.", "warn");
    }

    const newBalance = Number(user.wallet_tokens) + Number(adj.amount);
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Oyuncunun bakiyesi bu islem ile eksiye dusemez.", "err");
    }

    await client.query(`UPDATE users SET wallet_tokens = $1 WHERE id = $2`, [newBalance, adj.target_user_id]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, treasure_id, amount, type, created_at, metadata)
       VALUES ($1, NULL, $2, 'admin_adjustment', $3, $4::jsonb)`,
      [
        adj.target_user_id,
        adj.amount,
        now,
        JSON.stringify({
          reason: adj.reason,
          request_id: requestId,
          admin_id: req.adminSession.adminId,
        }),
      ]
    );
    await client.query(
      `UPDATE token_adjustment_requests SET status = 'approved', approved_at = $1 WHERE id = $2`,
      [now, requestId]
    );
    await client.query("COMMIT");

    await logAdminAction(req.adminSession.adminId, "token_adjustment_approved", { requestId, targetUserId: adj.target_user_id, amount: adj.amount }, ip);

    return redirectWithMsg(res, "/admin/tokens", "Token islemi onaylandi; bakiye guncellendi.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin/tokens/approve]", err);
    return redirectWithMsg(res, "/admin/tokens", "Onay sirasinda sunucu hatasi.", "err");
  } finally {
    client.release();
  }
});

router.post("/tokens/:requestId/reject", requireAdminSession, async (req, res) => {
  const requestId = Number(req.params.requestId);
  const ip = getIp(req);

  await expirePendingTokenRequests(db, Date.now());

  if (!Number.isFinite(requestId)) {
    return redirectWithMsg(res, "/admin/tokens", "Gecersiz talep kimligi.", "err");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const reqResult = await client.query(`SELECT id, status FROM token_adjustment_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const adj = reqResult.rows[0];
    if (!adj) {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Talep bulunamadi.", "warn");
    }
    if (adj.status !== "pending") {
      await client.query("ROLLBACK");
      return redirectWithMsg(res, "/admin/tokens", "Bu talep bekleyen durumda degil.", "warn");
    }

    await client.query(
      `UPDATE token_adjustment_requests SET status = 'rejected', rejected_at = $1 WHERE id = $2`,
      [Date.now(), requestId]
    );
    await client.query("COMMIT");
    await logAdminAction(req.adminSession.adminId, "token_adjustment_rejected", { requestId }, ip);
    return redirectWithMsg(res, "/admin/tokens", "Talep reddedildi.", "warn");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin/tokens/reject]", err);
    return redirectWithMsg(res, "/admin/tokens", "Ret islemi basarisiz.", "err");
  } finally {
    client.release();
  }
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
          <button class="btn neutral">Filtrele</button>
          <a class="btn neutral" href="/admin/suspicious">Temizle</a>
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

router.post("/tokens/adjust", requireAdminSession, respondBlockedUnsafeTokenAttempt);

router.post("/users/:id/tokens", requireAdminSession, respondBlockedUnsafeTokenAttempt);

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

router.respondBlockedUnsafeTokenAttempt = respondBlockedUnsafeTokenAttempt;
module.exports = router;
