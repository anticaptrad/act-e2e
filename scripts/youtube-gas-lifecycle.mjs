#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INGEST_BYTES = 8 * 1024 * 1024;
const MAX_RENDER_RECEIPT_BYTES = 256 * 1024;
const DEFAULT_VIDEO = resolve('tmp/youtube-lifecycle/anticaptrad-pg13-lifecycle-180s.mp4');
const DEFAULT_METADATA = resolve('fixtures/youtube-lifecycle/metadata.json');
const DEFAULT_RECEIPT = resolve('tmp/youtube-lifecycle/youtube-lifecycle-receipt.json');

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizeHandle(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function lifecycleConfig(environment = process.env) {
  return {
    gasUrl: required(environment.YOUTUBE_GAS_URL, 'YOUTUBE_GAS_URL'),
    apiKey: String(environment.YOUTUBE_GAS_API_KEY ?? '').trim(),
    expectedHandle: normalizeHandle(environment.YOUTUBE_GAS_EXPECTED_CHANNEL_HANDLE ?? '@anticaptrad'),
    expectedChannelId: String(environment.YOUTUBE_GAS_EXPECTED_CHANNEL_ID ?? '').trim(),
    videoPath: resolve(environment.YOUTUBE_E2E_VIDEO_PATH ?? DEFAULT_VIDEO),
    metadataPath: resolve(environment.YOUTUBE_E2E_METADATA_PATH ?? DEFAULT_METADATA),
    receiptPath: resolve(environment.YOUTUBE_E2E_RECEIPT_PATH ?? DEFAULT_RECEIPT),
    renderReceiptPath: String(environment.YOUTUBE_E2E_RENDER_RECEIPT_PATH ?? '').trim()
      ? resolve(environment.YOUTUBE_E2E_RENDER_RECEIPT_PATH)
      : '',
    allowPublic: environment.YOUTUBE_E2E_ALLOW_PUBLIC === 'true',
    publicApproval: String(environment.YOUTUBE_E2E_PUBLIC_APPROVAL ?? '').trim(),
    timeoutMs: Number(environment.YOUTUBE_E2E_GAS_TIMEOUT_MS ?? 300_000),
    maxPolls: Number(environment.YOUTUBE_E2E_MAX_POLLS ?? 12),
    repository: environment.YOUTUBE_E2E_REPOSITORY ?? 'https://github.com/anticaptrad/act-e2e',
    commit: environment.YOUTUBE_E2E_GIT_COMMIT ?? gitCommit(),
  };
}

function assertConfig(config) {
  const parsed = new URL(config.gasUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'script.google.com') {
    throw new Error('YOUTUBE_GAS_URL must be an HTTPS script.google.com deployment URL');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600_000) {
    throw new Error('YOUTUBE_E2E_GAS_TIMEOUT_MS must be between 1000 and 600000');
  }
  if (!Number.isInteger(config.maxPolls) || config.maxPolls < 1 || config.maxPolls > 30) {
    throw new Error('YOUTUBE_E2E_MAX_POLLS must be an integer between 1 and 30');
  }
}

async function responseEnvelope(response, context) {
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`${context} did not return a JSON response`);
  }
  if (!response.ok) throw new Error(`${context} failed with HTTP ${response.status}`);
  if (json?.ok !== true) {
    const code = String(json?.error?.code ?? 'UNKNOWN_ERROR').slice(0, 100);
    const message = String(json?.error?.message ?? 'request failed').slice(0, 500);
    throw new Error(`${context} failed (${code}): ${message}`);
  }
  return json.data;
}

async function gasHealth(config, fetchImpl) {
  const url = new URL(config.gasUrl);
  url.searchParams.set('action', 'health');
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return responseEnvelope(response, 'Apps Script health');
}

async function gasPost(config, fetchImpl, action, payload = {}) {
  if (!config.apiKey) throw new Error('YOUTUBE_GAS_API_KEY is required for authenticated lifecycle stages');
  const response = await fetchImpl(config.gasUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, action, apiKey: config.apiKey }),
    redirect: 'follow',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return responseEnvelope(response, `Apps Script ${action}`);
}

function assertChannel(config, channelData) {
  const channel = channelData?.channel;
  const actualHandle = normalizeHandle(channel?.handle);
  if (!channel?.id) throw new Error('Apps Script channel response did not include a channel ID');
  if (actualHandle && actualHandle !== config.expectedHandle) {
    throw new Error(`wrong YouTube channel handle: expected ${config.expectedHandle}, received ${actualHandle}`);
  }
  if (!config.expectedChannelId) {
    throw new Error('YOUTUBE_GAS_EXPECTED_CHANNEL_ID is required before any channel mutation');
  }
  if (channel.id !== config.expectedChannelId) {
    throw new Error('Apps Script credentials do not own the configured AntiCapTrad channel ID');
  }
  if (channelData?.verification?.verified !== true) {
    throw new Error('Apps Script did not report a verified channel binding');
  }
  return { id: channel.id, handle: actualHandle || config.expectedHandle, title: channel.title };
}

export async function preflight(config, fetchImpl = fetch, options = {}) {
  assertConfig(config);
  const health = await gasHealth(config, fetchImpl);
  if (health?.app !== 'Anticaptrad YouTube Control Center') {
    throw new Error('unexpected Apps Script application identity');
  }
  if (health?.configured !== true) {
    throw new Error('Apps Script reports that first-run Drive/channel setup is incomplete');
  }

  if (!config.apiKey && options.allowPublicOnly === true) {
    return { health, authenticated: false, channel: null };
  }
  const channelData = await gasPost(config, fetchImpl, 'channel');
  return { health, authenticated: true, channel: assertChannel(config, channelData) };
}

async function readFixture(config) {
  const [video, file, metadataText] = await Promise.all([
    readFile(config.videoPath),
    stat(config.videoPath),
    readFile(config.metadataPath, 'utf8'),
  ]);
  if (!file.isFile() || file.size < 1 || file.size > MAX_INGEST_BYTES) {
    throw new Error(`fixture must be a non-empty file no larger than ${MAX_INGEST_BYTES} bytes`);
  }
  const metadata = JSON.parse(metadataText);
  if (metadata.expectedDurationSeconds !== 180 || metadata.contentRating !== 'PG-13 safe') {
    throw new Error('fixture metadata must declare the reviewed 180-second PG-13-safe contract');
  }
  if (metadata.rightsConfirmed !== true || metadata.initialPrivacyStatus !== 'private') {
    throw new Error('fixture metadata must confirm rights and private-first publication');
  }
  const sha256 = createHash('sha256').update(video).digest('hex');
  const render = config.renderReceiptPath
    ? await readApprovedRenderReceipt(config, { sha256, sizeBytes: file.size, metadata })
    : null;
  return {
    video,
    sizeBytes: file.size,
    sha256,
    metadata,
    render,
  };
}

function assertOnlyKeys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context}.${key} is not allowed`);
  }
}

function assertSha256(value, context) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ''))) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
}

function assertRelativePath(value, context) {
  const path = String(value ?? '');
  if (!path || path.startsWith('/') || path.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error(`${context} must be a confined relative path`);
  }
}

function validateReceiptShape(receipt) {
  assertOnlyKeys(
    receipt,
    ['schemaVersion', 'renderId', 'projectId', 'status', 'source', 'outputs', 'toolchain', 'reviewState', 'publication', 'createdAt'],
    'render receipt',
  );
  assertOnlyKeys(receipt.source, ['projectSha256', 'assets'], 'render receipt.source');
  assertSha256(receipt.source.projectSha256, 'render receipt.source.projectSha256');
  if (!Array.isArray(receipt.source.assets) || receipt.source.assets.length < 1 || receipt.source.assets.length > 100) {
    throw new Error('render receipt.source.assets must contain between 1 and 100 assets');
  }
  for (const [index, asset] of receipt.source.assets.entries()) {
    assertOnlyKeys(asset, ['assetId', 'sha256'], `render receipt.source.assets[${index}]`);
    assertSha256(asset.sha256, `render receipt.source.assets[${index}].sha256`);
  }
  if (!Array.isArray(receipt.outputs) || receipt.outputs.length < 1 || receipt.outputs.length > 20) {
    throw new Error('render receipt.outputs must contain between 1 and 20 outputs');
  }
  for (const [index, output] of receipt.outputs.entries()) {
    assertOnlyKeys(
      output,
      ['outputId', 'kind', 'relativePath', 'sha256', 'sizeBytes', 'durationMs', 'width', 'height', 'videoCodec', 'audioCodec', 'sourceWindow'],
      `render receipt.outputs[${index}]`,
    );
    assertRelativePath(output.relativePath, `render receipt.outputs[${index}].relativePath`);
    assertSha256(output.sha256, `render receipt.outputs[${index}].sha256`);
    if (output.sourceWindow !== undefined) {
      assertOnlyKeys(output.sourceWindow, ['startMs', 'endMs'], `render receipt.outputs[${index}].sourceWindow`);
    }
  }
  assertOnlyKeys(
    receipt.toolchain,
    ['renderer', 'rendererVersion', 'ffmpegVersion'],
    'render receipt.toolchain',
  );
  assertOnlyKeys(
    receipt.publication,
    ['provider', 'channelHandle', 'channelId', 'privacyStatus', 'privateUploadEligible', 'publicEligible'],
    'render receipt.publication',
  );
}

async function readApprovedRenderReceipt(config, fixture) {
  const receiptFile = await stat(config.renderReceiptPath);
  if (!receiptFile.isFile() || receiptFile.size < 1 || receiptFile.size > MAX_RENDER_RECEIPT_BYTES) {
    throw new Error(`render receipt must be a non-empty file no larger than ${MAX_RENDER_RECEIPT_BYTES} bytes`);
  }
  const receipt = JSON.parse(await readFile(config.renderReceiptPath, 'utf8'));
  validateReceiptShape(receipt);
  if (receipt.schemaVersion !== '1.0' || receipt.status !== 'succeeded' || receipt.reviewState !== 'approved') {
    throw new Error('render receipt must be a successful, approved schema 1.0 receipt');
  }
  if (receipt.toolchain.renderer !== 'act-desktop-app.rs') {
    throw new Error('render receipt must come from the native act-desktop-app.rs renderer');
  }
  const publication = receipt.publication;
  if (
    publication.provider !== 'youtube'
    || normalizeHandle(publication.channelHandle) !== config.expectedHandle
    || publication.channelId !== config.expectedChannelId
    || publication.privacyStatus !== 'private'
    || publication.privateUploadEligible !== true
    || publication.publicEligible !== false
  ) {
    throw new Error('render receipt is not eligible for private upload to the configured AntiCapTrad channel');
  }
  const expectedDurationMs = fixture.metadata.expectedDurationSeconds * 1000;
  const output = receipt.outputs.find((candidate) => (
    candidate.kind === 'master'
    && candidate.sha256 === fixture.sha256
    && candidate.sizeBytes === fixture.sizeBytes
    && Number.isInteger(candidate.durationMs)
    && Math.abs(candidate.durationMs - expectedDurationMs) <= 2_000
  ));
  if (!output) {
    throw new Error('render receipt has no master output matching the local video digest, size, and reviewed duration');
  }
  return {
    renderId: required(receipt.renderId, 'render receipt.renderId'),
    projectId: required(receipt.projectId, 'render receipt.projectId'),
    outputId: required(output.outputId, 'render receipt output.outputId'),
    relativePath: output.relativePath,
    renderer: receipt.toolchain.renderer,
  };
}

function uploadJobFrom(value) {
  return value?.job ?? value;
}

function videoIdFrom(job) {
  return job?.youtubeVideo?.id ?? job?.youtubeVideoId ?? '';
}

async function writeReceipt(receiptPath, receipt) {
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export async function uploadPrivate(config, fetchImpl = fetch) {
  const fixture = await readFixture(config);
  const verified = await preflight(config, fetchImpl);
  const correlation = fixture.sha256.slice(0, 32);

  const ingest = await gasPost(config, fetchImpl, 'ingestVideo', {
    controlRequestId: `youtube-e2e-ingest-${correlation}`,
    fileName: basename(config.videoPath),
    mimeType: 'video/mp4',
    sha256: fixture.sha256,
    base64: fixture.video.toString('base64'),
  });
  if (!ingest?.file?.id || ingest.contentSha256 !== fixture.sha256) {
    throw new Error('Apps Script ingest receipt did not match the local fixture');
  }

  const started = await gasPost(config, fetchImpl, 'startUpload', {
    controlRequestId: `youtube-e2e-start-${correlation}`,
    idempotencyKey: `youtube-e2e-${fixture.sha256}`,
    driveFileId: ingest.file.id,
    title: fixture.metadata.title,
    description: fixture.metadata.description,
    tags: fixture.metadata.tags,
    categoryId: fixture.metadata.categoryId,
    defaultLanguage: fixture.metadata.defaultLanguage,
    madeForKids: fixture.metadata.madeForKids,
    rightsConfirmed: fixture.metadata.rightsConfirmed,
    repository: config.repository,
    commit: config.commit,
  });

  let job = uploadJobFrom(started);
  if (!job?.id) throw new Error('Apps Script did not return an upload job ID');
  for (let attempt = 1; attempt <= config.maxPolls && job.status !== 'complete'; attempt += 1) {
    const processed = await gasPost(config, fetchImpl, 'processUpload', {
      controlRequestId: `youtube-e2e-process-${job.id}-${attempt}`,
      jobId: job.id,
      maxChunks: 12,
    });
    job = uploadJobFrom(processed);
  }
  if (job.status !== 'complete') {
    throw new Error(`YouTube upload did not complete after ${config.maxPolls} bounded process calls`);
  }

  const videoId = videoIdFrom(job);
  if (!videoId) throw new Error('completed upload job did not include a YouTube video ID');
  const videos = await gasPost(config, fetchImpl, 'videos', { maxResults: 50 });
  const uploaded = videos?.items?.find((video) => video.id === videoId);
  if (!uploaded || uploaded.privacyStatus !== 'private') {
    throw new Error('uploaded video was not verified as private on the expected channel');
  }

  const receipt = {
    schemaVersion: 1,
    stage: 'private',
    channel: verified.channel,
    source: { sha256: fixture.sha256, sizeBytes: fixture.sizeBytes, render: fixture.render },
    drive: { fileId: ingest.file.id, idempotentReplay: ingest.idempotentReplay === true },
    youtube: { videoId, url: `https://www.youtube.com/watch?v=${videoId}`, privacyStatus: 'private' },
    repository: config.repository,
    commit: config.commit,
  };
  await writeReceipt(config.receiptPath, receipt);
  return receipt;
}

export async function publishPublic(config, fetchImpl = fetch) {
  if (!config.allowPublic) {
    throw new Error('YOUTUBE_E2E_ALLOW_PUBLIC=true is required for the separate publication stage');
  }
  const receipt = JSON.parse(await readFile(config.receiptPath, 'utf8'));
  const videoId = required(receipt?.youtube?.videoId, 'receipt.youtube.videoId');
  const requiredApproval = `PUBLISH ${videoId} AS PUBLIC`;
  if (config.publicApproval !== requiredApproval) {
    throw new Error(`YOUTUBE_E2E_PUBLIC_APPROVAL must exactly equal ${requiredApproval}`);
  }

  await preflight(config, fetchImpl);
  await gasPost(config, fetchImpl, 'publishVideo', {
    controlRequestId: `youtube-e2e-publish-${videoId}`,
    videoId,
    privacyStatus: 'public',
    confirmation: requiredApproval,
  });
  const videos = await gasPost(config, fetchImpl, 'videos', { maxResults: 50 });
  const published = videos?.items?.find((video) => video.id === videoId);
  if (!published || published.privacyStatus !== 'public') {
    throw new Error('video publication was not verified on the expected channel');
  }

  const publicReceipt = {
    ...receipt,
    stage: 'public',
    youtube: { ...receipt.youtube, privacyStatus: 'public' },
  };
  await writeReceipt(config.receiptPath, publicReceipt);
  return publicReceipt;
}

async function main() {
  const stage = process.argv[2] ?? 'preflight';
  const config = lifecycleConfig();
  let result;
  if (stage === 'preflight') {
    result = await preflight(config, fetch, { allowPublicOnly: !config.apiKey });
  } else if (stage === 'upload-private') {
    result = await uploadPrivate(config);
  } else if (stage === 'publish') {
    result = await publishPublic(config);
  } else {
    throw new Error('stage must be preflight, upload-private, or publish');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
