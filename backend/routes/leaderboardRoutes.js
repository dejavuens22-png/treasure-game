const express = require("express");
const { db } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", authMiddleware, (_req, res) => {
  db.all(
    `
      SELECT id AS userId, username, wallet_tokens AS tokens
      FROM users
      ORDER BY wallet_tokens DESC, id ASC
      LIMIT 50
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "Leaderboard alinamadi." });
      }

      return res.json({ leaderboard: rows });
    }
  );
});

module.exports = router;
