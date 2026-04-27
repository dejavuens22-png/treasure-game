const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Yetkisiz erisim." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const resolvedUserId = payload?.userId ?? payload?.id;
    if (!resolvedUserId) {
      return res.status(401).json({ message: "Token icinde kullanici kimligi yok." });
    }

    req.user = {
      ...payload,
      userId: resolvedUserId,
      id: payload?.id ?? resolvedUserId,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ message: "Gecersiz token." });
  }
};

module.exports = authMiddleware;
