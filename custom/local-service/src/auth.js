'use strict';
const crypto = require('node:crypto');

function bearerOk(header, token) {
  if (!token) return false;
  const match = /^Bearer (.+)$/.exec(header || '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = { bearerOk };
