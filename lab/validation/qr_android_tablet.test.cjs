const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientOptions, messageSummary, requestHandler, installPlatformOverride } = require('./qr_android_tablet.cjs');

test('SMB_ANDROID override changes only platform in registration and login bytes, and restores exports', () => {
  const { proto } = require('zapo-js');
  const expected = { userAgent: { platform: proto.ClientPayload.UserAgent.Platform.WEB, device: 'Desktop', appVersion: { primary: 2, secondary: 3000, tertiary: 1 } }, webInfo: { webSubPlatform: 0 }, devicePairingData: { deviceProps: Buffer.from('private'), eIdent: Buffer.from('private-key') } };
  const original = () => proto.ClientPayload.encode(expected).finish();
  const builders = { buildRegistrationPayload: original, buildLoginPayload: original };
  const observed = [];
  const restore = installPlatformOverride(builders, proto, (event) => observed.push(event));
  for (const name of Object.keys(builders)) {
    const before = proto.ClientPayload.decode(original());
    const after = proto.ClientPayload.decode(builders[name]());
    assert.equal(after.userAgent.platform, proto.ClientPayload.UserAgent.Platform.SMB_ANDROID);
    after.userAgent.platform = before.userAgent.platform;
    assert.deepEqual(after, before);
  }
  assert.deepEqual(observed.map((event) => event.handshake), ['registration', 'login']);
  assert.ok(!JSON.stringify(observed).includes('private'));
  restore();
  assert.equal(builders.buildLoginPayload, original);
  assert.equal(builders.buildRegistrationPayload, original);
});
test('missing builder is rejected without partially changing exports', () => {
  const original = () => {};
  const builders = { buildRegistrationPayload: original };
  assert.throws(() => installPlatformOverride(builders, {}));
  assert.equal(builders.buildRegistrationPayload, original);
});
test('ordinary Android uses platform zero in both builders without Business fields', () => {
  const { proto } = require('zapo-js');
  const original = () => proto.ClientPayload.encode({ userAgent: { platform: 14, device: 'Desktop' } }).finish();
  const builders = { buildRegistrationPayload: original, buildLoginPayload: original };
  const observed = [];
  const restore = installPlatformOverride(builders, proto, (event) => observed.push(event), 'ANDROID');
  for (const builder of Object.values(builders)) {
    const payload = proto.ClientPayload.decode(builder());
    assert.equal(payload.userAgent.platform, proto.ClientPayload.UserAgent.Platform.ANDROID);
    assert.equal(payload.userAgent.device, 'Desktop');
  }
  assert.deepEqual(observed.map((event) => event.userAgent), ['ANDROID', 'ANDROID']);
  restore();
  assert.throws(() => installPlatformOverride(builders, proto, () => {}, 'UNKNOWN'));
});

test('isolated session uses tablet + literal e without mobile credentials', () => {
  const store = {};
  assert.deepEqual(clientOptions(store), { store, sessionId: 'lab-qr-android-tablet-e', deviceBrowser: 'android tablet', devicePlatform: 'e', history: { enabled: false } });
});
test('view-once summary does not include content, media key or phone', () => {
  const result = messageSummary({ key: { remoteJid: 'secret' }, message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'secret', mediaKey: Buffer.from('secret'), directPath: 'secret' } } } } } } });
  assert.deepEqual(result, { viewOnce: true, type: 'image', mediaDescriptorPresent: true, mediaKeyPresent: true, mediaPathPresent: true });
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('normal message and native viewOnce flag remain distinct', () => {
  assert.equal(messageSummary({ message: { conversation: 'private' } }).viewOnce, false);
  assert.equal(messageSummary({ message: { audioMessage: { viewOnce: true } } }).viewOnce, true);
});
test('local page forbids alternate hosts, mutations and caching', () => {
  for (const req of [{ method: 'POST', headers: { host: '127.0.0.1:19879' } }, { method: 'GET', headers: { host: 'evil.test:19879' } }]) {
    const headers = {};
    const res = { setHeader(k,v) { headers[k]=v; }, writeHead(code) { this.code=code; return this; }, end() {} };
    requestHandler({}, 19879)(req,res);
    assert.equal(res.code,403);
    assert.equal(headers['Cache-Control'],'no-store');
  }
});
test('state endpoint returns only provided sanitized state', () => {
  let body;
  const state = { status: 'Conectado', qr: null, events: [] };
  requestHandler(state,19879)({ method: 'GET', url: '/state', headers: { host: '127.0.0.1:19879' } }, { setHeader() {}, end(value) { body=value; } });
  assert.deepEqual(JSON.parse(body),state);
});
