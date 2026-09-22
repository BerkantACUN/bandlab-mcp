#!/usr/bin/env node
/**
 * Stem separation through BandLab's Splitter service.
 *
 * Mapped from the web app: a multipart POST starts the job, a status endpoint
 * is polled until `result === 1`, and a final GET returns the stems. Status and
 * download take no job id — the service tracks one separation per user.
 * Free accounts get vocals, drums, bass and other; 429 means the daily limit.
 *
 *   node --env-file-if-exists=.env scripts/split-stems.mjs <audio file> <out dir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { SessionManager } from '../dist/auth.js';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: split-stems.mjs <audio file> <out dir>');
  process.exit(1);
}

const BASE = 'https://source-separation.bandlab.io';
const STEMS = ['vocals', 'drums', 'bass', 'other'];

const config = loadConfig();
const token = await new SessionManager(config).getToken();
const headers = {
  authorization: `Bearer ${token}`,
  'x-client-id': 'BandLab-Web',
  'x-client-version': '10.2.77',
  origin: 'https://www.bandlab.com',
  referer: 'https://www.bandlab.com/studio',
};

const form = new FormData();
form.append('daily_limits_enabled', 'true');
form.append('file', new Blob([await readFile(input)]), basename(input));
form.append('stems', STEMS.join(','));
form.append('out_format', 'm4a');

console.log(`uploading ${basename(input)} for separation ...`);
const start = await fetch(`${BASE}/v4/separation`, { method: 'POST', headers, body: form });
const startText = await start.text();
console.log('start ->', start.status, startText.slice(0, 300));
if (!start.ok) process.exit(1);
const { result } = JSON.parse(startText);
console.log(`separation ${result.separation_id}, ~${result.approx_waiting_time_in_seconds}s`);

for (let i = 1; i <= 240; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const res = await fetch(`${BASE}/v1/separation/status`, { headers });
  if (!res.ok) {
    console.log(`  status HTTP ${res.status}`);
    continue;
  }
  const s = (await res.json()).result ?? {};
  if (i % 3 === 0 || s.result === 1) console.log(`  t+${i * 5}s status=${s.status} progress=${s.progress} result=${s.result}`);
  if (s.status === 'Failed') throw new Error(s.msg ?? 'separation failed');
  if (s.result === 1) break;
}

const dl = await fetch(`${BASE}/v1/separation`, { headers });
console.log('download ->', dl.status, dl.headers.get('content-type'));
await mkdir(outDir, { recursive: true });
const out = join(outDir, 'stems.bin');
await writeFile(out, Buffer.from(await dl.arrayBuffer()));
console.log('saved', out);
