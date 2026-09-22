/**
 * Audio upload, reverse-engineered from the web app's Sample factory.
 *
 * This is the piece missing from the v1.3 surface: none of its 123 endpoints
 * upload audio, because uploads live on v2.0 and that route rejects a bare
 * bearer token until the request also identifies itself as the web client.
 *
 * Three steps, none of them in the v1.3 surface this project otherwise uses:
 *   1. PUT /api/v2.0/uploads/samples/{sampleId}?format=wav  -> presigned URL
 *   2. PUT <presigned URL> with the raw bytes and a matching Content-Type
 *   3. GET /api/v2.0/uploads/{sampleId}                     -> sample metadata
 *
 * The editor decodes every non-MIDI file to WAV before uploading, so this does
 * the same rather than sending the original mp3.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { SessionManager } from '../dist/auth.js';

const WAV = process.argv[2];
if (!WAV) {
  console.error('usage: node scripts/upload-audio.mjs <file.wav>');
  console.error('Convert first, e.g.: ffmpeg -i song.mp3 -vn -ar 44100 -ac 2 -c:a pcm_s16le song.wav');
  process.exit(1);
}

const config = loadConfig();
const session = new SessionManager(config);
const token = await session.getToken();

const me = await (
  await fetch(`${config.apiBase}/me`, { headers: { authorization: `Bearer ${token}` } })
).json();

const sampleId = randomUUID();
console.log('sampleId:', sampleId);

// 1. Ask for somewhere to put it.
const grant = await fetch(
  `https://www.bandlab.com/api/v2.0/uploads/samples/${sampleId}?format=wav`,
  {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      // v2.0 refuses a bare bearer token; the web client identifies itself too.
      'x-client-id': 'BandLab-Web',
      'x-client-version': '10.2.77',
      origin: 'https://www.bandlab.com',
      referer: 'https://www.bandlab.com/studio',
      'X-Amz-Meta-User-Id': me.id,
      'X-Amz-Meta-Device': '',
      'X-Amz-Meta-Source': '',
    },
  },
);
const grantText = await grant.text();
// A 401 here almost always means the x-client-id header was dropped.
console.log('step 1 ->', grant.status);
if (!grant.ok) {
  console.log(grantText.slice(0, 400));
  process.exit(1);
}
const uploadUrl = JSON.parse(grantText).value;
console.log('presigned host:', new URL(uploadUrl).host);

// 2. Send the bytes.
const bytes = await readFile(WAV);
console.log(`uploading ${(bytes.length / 1024 / 1024).toFixed(1)} MB ...`);
const put = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'audio/wav' },
  body: bytes,
});
console.log('step 2 ->', put.status);
if (!put.ok) {
  console.log((await put.text()).slice(0, 400));
  process.exit(1);
}

// 3. Confirm the server accepted and processed it.
for (let i = 1; i <= 20; i += 1) {
  await new Promise((r) => setTimeout(r, 4000));
  const meta = await fetch(`https://www.bandlab.com/api/v2.0/uploads/${sampleId}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-client-id': 'BandLab-Web',
      'x-client-version': '10.2.77',
    },
  });
  if (!meta.ok) {
    console.log(`  t+${i * 4}s  HTTP ${meta.status}`);
    continue;
  }
  const data = await meta.json();
  console.log(`  t+${i * 4}s  status=${data.status} duration=${data.duration ?? '-'}`);
  if (data.status === 'Ready') {
    console.log('\nSAMPLE_ID=' + sampleId);
    console.log('DURATION=' + data.duration);
    console.log('AUDIO=' + (data.audioUrl ?? data.file ?? '-'));
    break;
  }
}
