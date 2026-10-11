// Security regression tests for server.js — run with: npm test (node --test)
// Spawns the real server as a subprocess so middleware order is exercised
// exactly as in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const VERIFY_TOKEN = '***';
const APP_SECRET = '***';
const API_KEY = '***';

function startServer(extraEnv) {
  const env = {
    ...process.env,
    VERIFY_TOKEN,
    APP_SECRET,
    API_KEY,
    PORT: String(20000 + Math.floor(Math.random() * 10000)),
    DB_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'watest-')) + '/test.db',
    ...extraEnv
  };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.resume(); // drain so the child never blocks
  proc.stderr.resume();
  return { proc, port: env.PORT };
}

async function waitUp(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const base = (port) => `http://127.0.0.1:${port}`;
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');

const WA_PAYLOAD = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { display_phone_number: '15551234567' },
    messages: [{ from: '60123456789', id: 'wamid.TEST', type: 'text', text: { body: 'hello' } }]
  } }] }]
});

// ── Server with all secrets configured ─────────────────────────
let srv;
before(async () => { srv = startServer({}); await waitUp(srv.port); });
after(() => srv.proc.kill());

test('GET /health is open and returns 200', async () => {
  const r = await fetch(`${base(srv.port)}/health`);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.status, 'ok');
});

test('GET /webhook hub.challenge still works', async () => {
  const r = await fetch(`${base(srv.port)}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), '12345');
});

test('GET /webhook rejects wrong verify token', async () => {
  const r = await fetch(`${base(srv.port)}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.strictEqual(r.status, 403);
});

test('POST /webhook with valid signature is accepted', async () => {
  const r = await fetch(`${base(srv.port)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(WA_PAYLOAD) },
    body: WA_PAYLOAD
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'EVENT_RECEIVED');
});

test('POST /webhook without signature → 401', async () => {
  const r = await fetch(`${base(srv.port)}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: WA_PAYLOAD
  });
  assert.strictEqual(r.status, 401);
});

test('POST /webhook with wrong signature → 401', async () => {
  const r = await fetch(`${base(srv.port)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
    body: WA_PAYLOAD
  });
  assert.strictEqual(r.status, 401);
});

test('POST /webhook signature over tampered body → 401', async () => {
  const r = await fetch(`${base(srv.port)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(WA_PAYLOAD) },
    body: WA_PAYLOAD + ' '
  });
  assert.strictEqual(r.status, 401);
});

test('API key: missing → 401, wrong → 401, correct → 200', async () => {
  const missing = await fetch(`${base(srv.port)}/api/stats`);
  assert.strictEqual(missing.status, 401);
  const wrong = await fetch(`${base(srv.port)}/api/stats`, { headers: { 'X-API-Key': 'nope' } });
  assert.strictEqual(wrong.status, 401);
  const ok = await fetch(`${base(srv.port)}/api/stats`, { headers: { 'X-API-Key': API_KEY } });
  assert.strictEqual(ok.status, 200);
  const j = await ok.json();
  assert.ok('total_phones' in j && 'pending_messages' in j); // response shape preserved
});

test('API key guards every /api route (pending, limits, conversations)', async () => {
  for (const p of ['/api/messages/pending', '/api/limits/60123456789', '/api/conversations/60123456789/messages']) {
    const r = await fetch(`${base(srv.port)}${p}`);
    assert.strictEqual(r.status, 401, `${p} should require API key`);
  }
});

test('SQL injection in waId param cannot break query', async () => {
  const evil = encodeURIComponent("60123456789' OR '1'='1' --");
  const r = await fetch(`${base(srv.port)}/api/conversations/${evil}/messages`, { headers: { 'X-API-Key': API_KEY } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), []); // parameterized: matches nothing, no dump
});

test('security headers present on responses', async () => {
  const r = await fetch(`${base(srv.port)}/health`);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'; frame-ancestors 'none'/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(r.headers.get('permissions-policy'));
  const api = await fetch(`${base(srv.port)}/api/stats`, { headers: { 'X-API-Key': API_KEY } });
  assert.strictEqual(api.headers.get('cache-control'), 'no-store');
});

test('malformed JSON → generic 400, no stack leak', async () => {
  const r = await fetch(`${base(srv.port)}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign('{bad') }, body: '{bad'
  });
  assert.strictEqual(r.status, 400);
  const text = await r.text();
  assert.ok(!/at .*\.js|Error:/.test(text), 'response must not contain stack/exception text');
});

// ── Fail-closed: secrets unset ─────────────────────────────────
let noSecrets;
before(async () => { noSecrets = startServer({ APP_SECRET: '', API_KEY: '' }); await waitUp(noSecrets.port); });
after(() => noSecrets.proc.kill());

test('POST /webhook fails CLOSED (503) when APP_SECRET unset', async () => {
  const r = await fetch(`${base(noSecrets.port)}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(WA_PAYLOAD) },
    body: WA_PAYLOAD
  });
  assert.strictEqual(r.status, 503);
});

test('/api/* fails CLOSED (503) when API_KEY unset; /health stays open', async () => {
  const r = await fetch(`${base(noSecrets.port)}/api/stats`, { headers: { 'X-API-Key': API_KEY } });
  assert.strictEqual(r.status, 503);
  const h = await fetch(`${base(noSecrets.port)}/health`);
  assert.strictEqual(h.status, 200);
});
