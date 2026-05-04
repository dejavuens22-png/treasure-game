"use strict";

const test = require("node:test");
const assert = require("node:assert");

test("deprecated token endpoints use 403 handler (no redirect / no balance change path)", async () => {
  const adminRoutes = require("../routes/adminRoutes");
  const respondBlockedUnsafeTokenAttempt = adminRoutes.respondBlockedUnsafeTokenAttempt;
  assert.strictEqual(typeof respondBlockedUnsafeTokenAttempt, "function");

  const req = {
    method: "POST",
    originalUrl: "/admin/users/42/tokens",
    url: "/users/42/tokens",
    headers: {},
    adminSession: { adminId: 1 },
    ip: "127.0.0.1",
  };

  const res = {
    statusCode: 200,
    _type: null,
    _body: null,
    status(n) {
      this.statusCode = n;
      return this;
    },
    type(t) {
      this._type = t;
      return this;
    },
    send(b) {
      this._body = b;
      return this;
    },
  };

  await respondBlockedUnsafeTokenAttempt(req, res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res._type, "txt");
  assert.ok(String(res._body).includes("Forbidden"), "body should indicate forbidden");
});
