require("dotenv").config();
const express = require("express");
const { initDb } = require("./db");
const authRoutes = require("./routes/authRoutes");
const gameRoutes = require("./routes/gameRoutes");
const walletRoutes = require("./routes/walletRoutes");
const leaderboardRoutes = require("./routes/leaderboardRoutes");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

initDb();

app.get("/", (_req, res) => {
  res.json({ message: "Treasure Hunting Backend ayakta." });
});

app.use("/auth", authRoutes);
app.use("/game", gameRoutes);
app.use("/wallet", walletRoutes);
app.use("/leaderboard", leaderboardRoutes);

app.listen(PORT, () => {
  console.log(`Server calisti: http://localhost:${PORT}`);
});
