#!/usr/bin/env node
/**
 * AI harmony vocals through BandLab's Harmonizer service.
 *
 * Mapped from the web app: POST the vocal with a voice model and an interval,
 * poll the task until Completed, then download a zip holding one WAV.
 *
 *   node --env-file-if-exists=.env scripts/harmonize.mjs <vocal.wav> <voiceId> <semitones> <out.wav>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { SessionManager } from '../dist/auth.js';

const [input, voiceId, semitones, output] = process.argv.slice(2);
if (!output) {
  console.error('usage: harmonize.mjs <vocal.wav> <voiceId> <semitones> <out.zip>');
  process.exit(1);
}

const BASE = 'https://harmonizer.bandlab.cloud/v1';
const token = await new SessionManager(loadConfig()).getToken();
const headers = { authorization: `Bearer ${token}`, 'x-client-id': 'BandLab-Web', 'x-client-version': '10.2.77' };

const form = new FormData();
form.append('audio', new Blob([await readFile(input)]), basename(input));
form.append('voice_id', voiceId);
form.append('pitch_shift', String(semitones));
form.append('output_format', 'wav');

const start = await fetch(`${BASE}/task?is_preview=false`, { method: 'POST', headers, body: form });
const startText = await start.text();
console.log('start ->', start.status, startText.slice(0, 200));
if (!start.ok) process.exit(1);
const { taskId } = JSON.parse(startText);

for (let i = 1; i <= 300; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const task = await (await fetch(`${BASE}/task/${taskId}`, { headers })).json();
  if (i % 10 === 0) console.log(`  t+${i * 2}s ${task.status}`);
  if (task.status === 'Completed') break;
  if (task.status === 'Failed') throw new Error(task.error ?? 'harmonizer failed');
}

const dl = await fetch(`${BASE}/task/${taskId}/download`, { headers });
console.log('download ->', dl.status, dl.headers.get('content-type'));
await writeFile(output, Buffer.from(await dl.arrayBuffer()));
console.log('saved', output);
