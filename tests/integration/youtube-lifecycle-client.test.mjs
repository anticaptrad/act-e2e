import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  lifecycleConfig,
  preflight,
  publishPublic,
  uploadPrivate,
} from '../../scripts/youtube-gas-lifecycle.mjs';

const TMP = resolve('tmp/youtube-lifecycle-client-test');
const VIDEO = resolve(TMP, 'fixture.mp4');
const METADATA = resolve(TMP, 'metadata.json');
const RECEIPT = resolve(TMP, 'receipt.json');
const RENDER_RECEIPT = resolve(TMP, 'render-receipt.json');
const CHANNEL_ID = 'UC_ANTICAPTRAD_E2E';
const VIDEO_ID = 'video-e2e-001';

function fixtureMedia() {
  const media = Buffer.alloc(128);
  media.write('ftyp', 4, 'ascii');
  return media;
}

async function fixtureConfig(overrides = {}) {
  await mkdir(TMP, { recursive: true, mode: 0o700 });
  const media = fixtureMedia();
  await writeFile(VIDEO, media, { mode: 0o600 });
  await writeFile(
    METADATA,
    `${JSON.stringify({
      expectedDurationSeconds: 180,
      contentRating: 'PG-13 safe',
      rightsConfirmed: true,
      initialPrivacyStatus: 'private',
      title: 'Lifecycle fixture',
      description: 'Synthetic fixture',
      tags: ['anticaptrad'],
      categoryId: '27',
      defaultLanguage: 'en',
      madeForKids: false,
    })}\n`,
    { mode: 0o600 },
  );
  return lifecycleConfig({
    YOUTUBE_GAS_URL: 'https://script.google.com/macros/s/fake/exec',
    YOUTUBE_GAS_API_KEY: 'test-only-api-key',
    YOUTUBE_GAS_EXPECTED_CHANNEL_HANDLE: '@anticaptrad',
    YOUTUBE_GAS_EXPECTED_CHANNEL_ID: CHANNEL_ID,
    YOUTUBE_E2E_VIDEO_PATH: VIDEO,
    YOUTUBE_E2E_METADATA_PATH: METADATA,
    YOUTUBE_E2E_RECEIPT_PATH: RECEIPT,
    YOUTUBE_E2E_GIT_COMMIT: '0123456789abcdef',
    ...overrides,
  });
}

async function writeRenderReceipt(overrides = {}) {
  const media = fixtureMedia();
  const receipt = {
    schemaVersion: '1.0',
    renderId: 'render-e2e-001',
    projectId: 'project-e2e-001',
    status: 'succeeded',
    source: {
      projectSha256: 'a'.repeat(64),
      assets: [{ assetId: 'camera-primary', sha256: 'b'.repeat(64) }],
    },
    outputs: [{
      outputId: 'master-landscape',
      kind: 'master',
      relativePath: 'outputs/master-landscape.mp4',
      sha256: createHash('sha256').update(media).digest('hex'),
      sizeBytes: media.length,
      durationMs: 180_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    }],
    toolchain: {
      renderer: 'act-desktop-app.rs',
      rendererVersion: '0.1.0',
      ffmpegVersion: 'ffmpeg test fixture',
    },
    reviewState: 'approved',
    publication: {
      provider: 'youtube',
      channelHandle: '@anticaptrad',
      channelId: CHANNEL_ID,
      privacyStatus: 'private',
      privateUploadEligible: true,
      publicEligible: false,
    },
    createdAt: '2026-08-29T00:00:00Z',
    ...overrides,
  };
  await writeFile(RENDER_RECEIPT, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

function json(data) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeBridge({ channelId = CHANNEL_ID } = {}) {
  const calls = [];
  let privacyStatus = 'private';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    assert.ok(!url.searchParams.has('apiKey'), 'API key must never enter a URL');
    if ((init.method ?? 'GET') === 'GET') {
      calls.push({ action: 'health', payload: null });
      return json({
        app: 'Anticaptrad YouTube Control Center',
        version: '1.1.0',
        configured: true,
      });
    }

    const payload = JSON.parse(init.body);
    assert.equal(payload.apiKey, 'test-only-api-key');
    calls.push({ action: payload.action, payload });
    if (payload.action === 'channel') {
      return json({
        channel: { id: channelId, handle: '@anticaptrad', title: 'AntiCapTrad' },
        verification: { verified: true },
      });
    }
    if (payload.action === 'ingestVideo') {
      const bytes = Buffer.from(payload.base64, 'base64');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
      return json({
        file: { id: 'drive-file-001', size: bytes.length, mimeType: 'video/mp4' },
        contentSha256: payload.sha256,
        idempotentReplay: false,
      });
    }
    if (payload.action === 'startUpload') {
      assert.equal(payload.driveFileId, 'drive-file-001');
      assert.equal(payload.madeForKids, false);
      assert.equal(payload.rightsConfirmed, true);
      return json({ job: { id: 'job-001', status: 'queued' } });
    }
    if (payload.action === 'processUpload') {
      return json({ id: 'job-001', status: 'complete', youtubeVideo: { id: VIDEO_ID } });
    }
    if (payload.action === 'videos') {
      return json({ items: [{ id: VIDEO_ID, privacyStatus }] });
    }
    if (payload.action === 'publishVideo') {
      assert.equal(payload.confirmation, `PUBLISH ${VIDEO_ID} AS PUBLIC`);
      privacyStatus = 'public';
      return json({ id: VIDEO_ID, status: { privacyStatus } });
    }
    throw new Error(`unexpected fake action: ${payload.action}`);
  };
  return { calls, fetchImpl };
}

test('lifecycle uploads privately, verifies the channel, and requires a separate publish stage', async () => {
  const config = await fixtureConfig();
  const bridge = fakeBridge();
  const receipt = await uploadPrivate(config, bridge.fetchImpl);

  assert.equal(receipt.stage, 'private');
  assert.equal(receipt.channel.id, CHANNEL_ID);
  assert.equal(receipt.youtube.videoId, VIDEO_ID);
  assert.equal(receipt.youtube.privacyStatus, 'private');
  assert.deepEqual(
    bridge.calls.map((call) => call.action),
    ['health', 'channel', 'ingestVideo', 'startUpload', 'processUpload', 'videos'],
  );

  await assert.rejects(() => publishPublic(config, bridge.fetchImpl), /ALLOW_PUBLIC=true/);
  const approved = {
    ...config,
    allowPublic: true,
    publicApproval: `PUBLISH ${VIDEO_ID} AS PUBLIC`,
  };
  const publicReceipt = await publishPublic(approved, bridge.fetchImpl);
  assert.equal(publicReceipt.stage, 'public');
  assert.equal(publicReceipt.youtube.privacyStatus, 'public');
});

test('a mismatched channel ID fails before video ingest', async () => {
  const config = await fixtureConfig();
  const bridge = fakeBridge({ channelId: 'UC_WRONG_CHANNEL' });
  await assert.rejects(() => uploadPrivate(config, bridge.fetchImpl), /do not own/);
  assert.deepEqual(bridge.calls.map((call) => call.action), ['health', 'channel']);
});

test('an approved native render receipt binds the private upload to exact rendered bytes', async () => {
  await writeRenderReceipt();
  const config = await fixtureConfig({ YOUTUBE_E2E_RENDER_RECEIPT_PATH: RENDER_RECEIPT });
  const bridge = fakeBridge();
  const receipt = await uploadPrivate(config, bridge.fetchImpl);

  assert.deepEqual(receipt.source.render, {
    renderId: 'render-e2e-001',
    projectId: 'project-e2e-001',
    outputId: 'master-landscape',
    relativePath: 'outputs/master-landscape.mp4',
    renderer: 'act-desktop-app.rs',
  });
  assert.equal(bridge.calls[0].action, 'health');
});

test('a render receipt digest mismatch fails before any bridge request', async () => {
  const valid = await writeRenderReceipt();
  await writeRenderReceipt({
    outputs: [{ ...valid.outputs[0], sha256: 'c'.repeat(64) }],
  });
  const config = await fixtureConfig({ YOUTUBE_E2E_RENDER_RECEIPT_PATH: RENDER_RECEIPT });
  const bridge = fakeBridge();

  await assert.rejects(() => uploadPrivate(config, bridge.fetchImpl), /no master output matching/);
  assert.deepEqual(bridge.calls, []);
});

test('a render receipt cannot smuggle credentials or undeclared data into the pipeline', async () => {
  await writeRenderReceipt({ apiKey: 'must-not-be-accepted' });
  const config = await fixtureConfig({ YOUTUBE_E2E_RENDER_RECEIPT_PATH: RENDER_RECEIPT });
  const bridge = fakeBridge();

  await assert.rejects(() => uploadPrivate(config, bridge.fetchImpl), /apiKey is not allowed/);
  assert.deepEqual(bridge.calls, []);
});

test('public-only preflight works without decrypting the API key', async () => {
  const config = await fixtureConfig({ YOUTUBE_GAS_API_KEY: '' });
  const bridge = fakeBridge();
  const result = await preflight(config, bridge.fetchImpl, { allowPublicOnly: true });
  assert.equal(result.authenticated, false);
  assert.equal(result.health.configured, true);
  assert.deepEqual(bridge.calls.map((call) => call.action), ['health']);
});
