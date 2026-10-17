#!/usr/bin/env node
/**
 * Сборка зашифрованного отчёта из ответов на Яндекс.Диске.
 * Запускается на GitHub Actions по расписанию.
 *
 * Переменные окружения:
 *   YA_TOKEN         — OAuth-токен Яндекс.Диска (секрет репозитория)
 *   REPORT_PASSWORD  — пароль отчёта (секрет репозитория)
 *
 * Пишет data.enc.json рядом с index.html. Секреты никуда не попадают.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const API = 'https://cloud-api.yandex.net/v1/disk/resources';
const DIR = process.env.YA_DIR || 'app:/oprosnik/answers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data.enc.json');

const POSITIVE_MIN = 7;
const ITERATIONS = 310000;

/* Тестовые прохождения (мои проверки) в отчёт не берём */
/* Тестовые прохождения можно исключить через EXCLUDE_CLIENT_PREFIXES.
   По умолчанию не исключаем: отчёт показывает всё, что лежит на Диске. */
const EXCLUDE_PREFIXES = (process.env.EXCLUDE_CLIENT_PREFIXES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const TEXT_QUESTIONS = [
  'Что не понравилось или смутило? Только честно.',
  'Супер! Рады видеть вас снова. Какую услугу Вы посещали в этот раз?',
  'Что нужно срочно исправить в нашей работе?'
];

const token = (process.env.YA_TOKEN || '').trim();
const password = (process.env.REPORT_PASSWORD || '').trim();

if (!token) { console.error('Нет YA_TOKEN'); process.exit(1); }
if (!password) { console.error('Нет REPORT_PASSWORD'); process.exit(1); }

const auth = { Authorization: 'OAuth ' + token };

async function api(p, params) {
  const url = API + p + (params ? '?' + new URLSearchParams(params) : '');
  const r = await fetch(url, { headers: auth });
  let j = {};
  try { j = await r.json(); } catch { j = {}; }
  if (!r.ok) throw new Error(j.message || j.description || ('HTTP ' + r.status));
  return j;
}

async function listFiles() {
  const out = [];
  let offset = 0;
  for (;;) {
    const j = await api('', {
      path: DIR, limit: 1000, offset, sort: 'created',
      fields: '_embedded.items.name,_embedded.items.path,_embedded.items.type'
    });
    const items = (j._embedded && j._embedded.items) || [];
    for (const it of items) if (it.type === 'file') out.push(it);
    if (items.length < 1000) break;
    offset += items.length;
  }
  return out;
}

async function readOne(item) {
  const j = await api('/download', { path: item.path });
  const r = await fetch(j.href);
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  return JSON.parse(await r.text());
}

const isExcluded = (e) => {
  const c = String(e.clientId || '');
  return EXCLUDE_PREFIXES.some((p) => c.startsWith(p));
};

const files = await listFiles();
console.log('файлов на Диске:', files.length);

const entries = [];
const failed = [];
for (let i = 0; i < files.length; i += 4) {
  const res = await Promise.all(files.slice(i, i + 4).map(async (f) => {
    try { return await readOne(f); } catch (err) { return { __fail: f.name, __err: err.message }; }
  }));
  for (const x of res) {
    if (!x) continue;
    if (x.__fail) { failed.push(x); continue; }
    if (x.id && !isExcluded(x)) entries.push(x);
  }
}
if (failed.length) {
  console.log('не прочитано:', failed.length);
  failed.forEach((f) => console.log('  ', f.__fail, '—', f.__err));
}
console.log('учитываю прохождений:', entries.length);

/* ---------- агрегаты ---------- */
const rated = entries.filter((e) => typeof e.rating === 'number' && e.rating > 0);
const avg = (arr) => arr.length ? arr.reduce((s, e) => s + e.rating, 0) / arr.length : 0;

const dist = {};
for (let i = 1; i <= 9; i++) dist[i] = 0;
rated.forEach((e) => { if (dist[e.rating] != null) dist[e.rating]++; });

const qmap = {};
entries.forEach((e) => {
  const a = e.answers || {};
  Object.keys(a).forEach((q) => {
    const raw = a[q];
    const vals = (Array.isArray(raw) ? raw : [raw]).filter((v) => v != null && String(v).trim() !== '');
    if (!vals.length) return;
    if (!qmap[q]) qmap[q] = { counts: {}, texts: [] };
    vals.forEach((v) => {
      const k = String(v);
      qmap[q].counts[k] = (qmap[q].counts[k] || 0) + 1;
    });
    qmap[q].texts.push({
      name: e.name || '',
      date: e.date || '',
      value: vals.map((v) => String(v)).join(', ')
    });
  });
});

const isText = (q) => TEXT_QUESTIONS.indexOf(q) !== -1;

const questions = Object.keys(qmap).map((q) => {
  const c = qmap[q].counts;
  const items = Object.keys(c).sort((a, b) => c[b] - c[a])
    .map((k) => ({ value: k, count: c[k] }));
  const text = isText(q);
  return {
    q,
    type: text ? 'text' : 'choice',
    answers: entries.length,
    items: text ? [] : items,
    texts: text ? qmap[q].texts.filter((t) => t.value.trim()) : []
  };
}).sort((a, b) => {
  if (a.type !== b.type) return a.type === 'choice' ? -1 : 1;
  return 0;
});

const responses = entries
  .slice()
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .map((e) => ({
    id: e.id || '',
    clientId: e.clientId || '',
    name: e.name || '',
    phone: e.phone || '',
    date: e.date || '',
    branch: e.branch || '',
    rating: typeof e.rating === 'number' ? e.rating : null,
    answers: e.answers || {}
  }));

const payload = {
  generatedAt: new Date().toISOString(),
  positiveMin: POSITIVE_MIN,
  total: entries.length,
  rated: rated.length,
  avgRating: avg(rated),
  positive: rated.filter((e) => e.rating >= POSITIVE_MIN).length,
  negative: rated.filter((e) => e.rating < POSITIVE_MIN).length,
  avgFirst: avg(rated.filter((e) => e.branch === 'first')),
  avgRepeat: avg(rated.filter((e) => e.branch === 'repeat')),
  firstCount: rated.filter((e) => e.branch === 'first').length,
  repeatCount: rated.filter((e) => e.branch === 'repeat').length,
  dist,
  questions,
  responses
};

/* ---------- шифрование ---------- */
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

const blob = {
  v: 1,
  alg: 'AES-256-GCM',
  kdf: 'PBKDF2-SHA256',
  iter: ITERATIONS,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  ct: ct.toString('base64')
};

await fs.writeFile(OUT, JSON.stringify(blob), 'utf8');

/* round-trip проверка */
const key2 = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const d = crypto.createDecipheriv('aes-256-gcm', key2, iv);
d.setAuthTag(tag);
const round = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
if (round.total !== payload.total) throw new Error('Проверка шифрования не прошла');

console.log('Записано:', OUT);
console.log('Прохождений:', payload.total,
  '| средний:', payload.avgRating ? payload.avgRating.toFixed(2) : '—',
  '| сгенерировано:', payload.generatedAt);
console.log('Шифрование проверено (round-trip OK).');
