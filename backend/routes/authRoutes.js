const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "username ve password zorunludur." });
  }

  if (password.length < 4) {
    return res.status(400).json({ message: "Sifre en az 4 karakter olmali." });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      "INSERT INTO users (username, password_hash, wallet_tokens) VALUES ($1, $2, 0) RETURNING id, username",
      [username, passwordHash]
    );

    return res.status(201).json({
      message: "Kayit basarili.",
      userId: result.rows[0].id,
      username: result.rows[0].username,
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "Bu kullanici adi zaten kayitli." });
    }

    console.error("[/auth/register] error:", err);
    return res.status(500).json({ message: "Kayit sirasinda hata olustu." });
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "username ve password zorunludur." });
  }

  try {
    const result = await db.query(
      "SELECT id, username, password_hash, wallet_tokens FROM users WHERE username = $1",
      [username]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: "Kullanici adi veya sifre hatali." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ message: "Kullanici adi veya sifre hatali." });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.json({
      message: "Giris basarili.",
      token,
    });
  } catch (err) {
    console.error("[/auth/login] error:", err);
    return res.status(500).json({ message: "Giris sirasinda hata olustu." });
  }
});

module.exports = router;