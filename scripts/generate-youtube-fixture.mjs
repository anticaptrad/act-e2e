#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DURATION_SECONDS = 180;
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTPUT = resolve('tmp/youtube-lifecycle/anticaptrad-pg13-lifecycle-180s.mp4');

const SLIDES = [
  ['MARKETS AND TRADITIONAL GOODS', 'A THREE MINUTE ANTICAPTRAD E2E PREVIEW'],
  ['WHAT CAN A PRICE FAIL TO MEASURE', 'FAMILY TIME  LOCAL ROOTS  PRIVACY  STEWARDSHIP'],
  ['INCENTIVES ARE NOT PROOF OF MOTIVE', 'SHOW THE MECHANISM  THE EVIDENCE  AND THE LIMITS'],
  ['MARKETS CAN ALSO PROTECT TRADITION', 'CHOICE  SCALE  INNOVATION  AND MATERIAL SECURITY'],
  ['ANSWER THE STRONGEST COUNTERARGUMENT', 'DISTINGUISH FACT  INFERENCE  HYPOTHESIS  AND JUDGMENT'],
  ['PRIVATE REVIEW BEFORE PUBLIC RELEASE', 'CHANNEL ID  PLAYBACK  RIGHTS  CITATIONS  EXPLICIT APPROVAL'],
];

function commandExists(command) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, ['-version'], { stdio: 'ignore' });
    child.once('error', () => resolvePromise(false));
    child.once('exit', (code) => resolvePromise(code === 0));
  });
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
      }
    });
  });
}

function selectFont() {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error('No supported sans-serif font found; run inside the Nix development shell.');
  }
  return selected;
}

function escapeFilter(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '\\%');
}

function videoFilter(fontFile) {
  const font = escapeFilter(fontFile);
  const filters = [
    'drawbox=x=0:y=0:w=iw:h=ih:color=0x111827:t=fill',
    'drawbox=x=70:y=70:w=iw-140:h=ih-140:color=0x1f2937@0.94:t=fill',
  ];

  SLIDES.forEach(([title, subtitle], index) => {
    const start = index * 30;
    const end = start + 29.999;
    const enabled = `enable='between(t,${start},${end})'`;
    filters.push(
      `drawtext=fontfile='${font}':text='${escapeFilter(title)}':fontcolor=0xf9fafb:fontsize=48:x=(w-text_w)/2:y=h*0.36:${enabled}`,
      `drawtext=fontfile='${font}':text='${escapeFilter(subtitle)}':fontcolor=0x93c5fd:fontsize=28:x=(w-text_w)/2:y=h*0.53:${enabled}`,
    );
  });

  filters.push(
    `drawtext=fontfile='${font}':text='PG-13 SAFE SYNTHETIC TEST ASSET  NOT FINAL EDITORIAL CONTENT':fontcolor=0x9ca3af:fontsize=20:x=(w-text_w)/2:y=h-105`,
    `drawtext=fontfile='${font}':text='@anticaptrad  PRIVATE FIRST LIFECYCLE PROOF':fontcolor=0x6ee7b7:fontsize=20:x=(w-text_w)/2:y=h-75`,
  );
  return filters.join(',');
}

async function probe(outputPath) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of',
    'json',
    outputPath,
  ]);
  return JSON.parse(stdout);
}

export async function generateFixture(outputPath = DEFAULT_OUTPUT) {
  if (!(await commandExists('ffmpeg')) || !(await commandExists('ffprobe'))) {
    throw new Error('ffmpeg and ffprobe are required; run nix develop ./.nix first.');
  }

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const fontFile = selectFont();
  const filter = videoFilter(fontFile);

  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x111827:s=1280x720:r=24:d=${DURATION_SECONDS}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=stereo:sample_rate=48000:d=${DURATION_SECONDS}`,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-t',
    String(DURATION_SECONDS),
    '-movflags',
    '+faststart',
    '-metadata',
    'title=AntiCapTrad PG-13 lifecycle proof',
    '-metadata',
    'comment=Synthetic test asset with original text and silence; private-first review required',
    destination,
  ]);

  const media = await readFile(destination);
  const file = await stat(destination);
  const details = await probe(destination);
  const duration = Number(details.format?.duration ?? 0);
  const streams = details.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  if (duration < 179.5 || duration > 180.5) {
    throw new Error(`fixture duration must be 180 seconds, got ${duration}`);
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`fixture exceeds the Apps Script ingest limit: ${file.size} > ${MAX_BYTES}`);
  }
  if (video?.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720) {
    throw new Error('fixture must be a 1280x720 H.264 video');
  }
  if (audio?.codec_name !== 'aac') {
    throw new Error('fixture must include an AAC audio track');
  }

  const manifest = {
    schemaVersion: 1,
    filePath: destination,
    fileName: basename(destination),
    mimeType: 'video/mp4',
    durationSeconds: duration,
    sizeBytes: file.size,
    sha256: createHash('sha256').update(media).digest('hex'),
    video: { codec: video.codec_name, width: video.width, height: video.height },
    audio: { codec: audio.codec_name },
    contentRating: 'PG-13 safe',
    rights: 'Original synthetic text, generated color fields, and generated silence only.',
  };
  const manifestPath = `${destination}.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { ...manifest, manifestPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await generateFixture(process.argv[2] ?? DEFAULT_OUTPUT);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
