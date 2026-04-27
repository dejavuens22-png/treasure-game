const express = require("express");
const { db } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, username, wallet_tokens FROM users WHERE id = $1",
      [req.user.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: "Kullanici bulunamadi." });
    }

    return res.json({
      userId: user.id,
      username: user.username,
      tokens: user.wallet_tokens,
    });
  } catch (err) {
    console.error("[/wallet] error:", err);
    return res.status(500).json({ message: "Wallet bilgisi alinamadi." });
  }
});

router.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT id, user_id, treasure_id, amount, type, created_at
      FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [req.user.userId]
    );

    return res.json({ transactions: result.rows });
  } catch (err) {
    console.error("[/wallet/transactions] error:", err);
    return res.status(500).json({ message: "Transaction gecmisi alinamadi." });
  }
});

module.exports = router;