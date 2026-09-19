'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bearerOk } = require('../src/auth');

test('accepts only the exact bearer token', () => {
  assert.equal(bearerOk('Bearer secret', 'secret'), true);
  assert.equal(bearerOk('Bearer secreT', 'secret'), false);
  assert.equal(bearerOk('Bearer secret2', 'secret'), false);
  assert.equal(bearerOk('secret', 'secret'), false);
  assert.equal(bearerOk('', 'secret'), false);
  assert.equal(bearerOk(undefined, 'secret'), false);
});

test('an empty configured token never authenticates anyone', () => {
  assert.equal(bearerOk('Bearer ', ''), false);
  assert.equal(bearerOk('Bearer x', ''), false);
});
