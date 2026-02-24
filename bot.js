const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = Number(process.env.ALLOWED_USER_ID || 0);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/app/downloads';
const API_ID = process.env.API_ID || '';
const API_HASH = process.env.API_HASH || '';
const STRING_SESSION = process.env.STRING_SESSION || '';
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || ALLOWED_USER_ID || 0);
const HAS_VALID_TELETHON_SESSION = !!(STRING_SESSION && STRING_SESSION.length > 100 && !/\s/.test(STRING_SESSION));

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const JOBS = new Map();
const ITEM_ACTIONS = new Map();

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function isAllowed(msg) {
  if (!ALLOWED_USER_ID) return true;
  return Number(msg.from?.id || 0) === ALLOWED_USER_ID;
}

function isUrl(t) {
  return /^https?:\/\//i.test((t || '').trim());
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function isSendableFile(f) {
  const n = path.basename(f).toLowerCase();
  return !n.endsWith('.json') && !n.endsWith('.part') && !n.endsWith('.ytdl') && !n.endsWith('.tmp');
}

function groupFilesByTopFolder(baseDir, files) {
  const groups = new Map();
  for (const f of files) {
    const rel = path.relative(baseDir, f);
    const parts = rel.split(path.sep);
    const key = parts.length > 1 ? parts[0] : '__root__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

function detectPostId(filePath) {
  const name = path.basename(filePath);
  const m = name.match(/_(\d+)_\d+\.[^.]+$/);
  return m ? m[1] : 'single';
}

function buildIndex(jobId, jobDir, files) {
  const groupsMap = groupFilesByTopFolder(jobDir, files);
  const groups = [];
  for (const [groupName, groupFiles] of groupsMap.entries()) {
    const postsMap = new Map();
    for (const f of groupFiles) {
      const pid = detectPostId(f);
      if (!postsMap.has(pid)) postsMap.set(pid, []);
      postsMap.get(pid).push(f);
    }
    const posts = [...postsMap.entries()].map(([postId, items]) => ({ postId, items }));
    groups.push({ groupName, files: groupFiles, posts });
  }
  const model = { jobId, jobDir, groups, createdAt: Date.now() };
  JOBS.set(jobId, model);
  return model;
}

function actionRows(jobId, gIdx, pIdx = null) {
  const target = pIdx === null ? `ag:${jobId}:${gIdx}:` : `ap:${jobId}:${gIdx}:${pIdx}:`;
  return [
    [
      { text: '📤 Original', callback_data: `${target}oq` },
      { text: '🎬 HD', callback_data: `${target}hd` },
      { text: '📱 SD', callback_data: `${target}sd` },
    ],
    [
      { text: '🗜 Compress', callback_data: `${target}c` },
      { text: '✨ Lossless', callback_data: `${target}lq` },
    ],
    [
      { text: '🖼 Screenshots', callback_data: `${target}h` },
      { text: '✂️ Trim 30s', callback_data: `${target}t` },
    ],
    pIdx === null ? [{ text: '🧹 Cleanup group files', callback_data: `clg:${jobId}:${gIdx}` }] : [],
  ].filter(r => r.length);
}

function perVideoActionRows(token) {
  return [
    [
      { text: '📤 Original', callback_data: `va:${token}:oq` },
      { text: '🎬 HD', callback_data: `va:${token}:hd` },
      { text: '📱 SD', callback_data: `va:${token}:sd` },
    ],
    [
      { text: '🗜 Compress', callback_data: `va:${token}:c` },
      { text: '✨ Lossless', callback_data: `va:${token}:lq` },
    ],
    [
      { text: '🖼 Screenshots', callback_data: `va:${token}:h` },
      { text: '✂️ Trim 30s', callback_data: `va:${token}:t` },
    ],
  ];
}

function extractMediaLinks(html) {
  const normalized = String(html || '').replace(/\\\//g, '/');
  const re = /https?:\/\/[^\s"'<>]+\.(?:mp4|m4v|mov|mkv|webm|avi|m4s|ts|m3u8|jpg|jpeg|png|gif|webp)(?:\?[^\s"'<>]*)?/gi;
  const found = normalized.match(re) || [];
  const out = [];
  const seen = new Set();
  for (const u of found) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findMetadata(jobDir) {
  try {
    const jsonFiles = walk(jobDir).filter((f) => f.endsWith('.json'));
    for (const jf of jsonFiles) {
      try {
        const raw = fs.readFileSync(jf, 'utf8');
        const data = JSON.parse(raw);
        const title = data.title || data.filename || data.id || null;
        const href = data.webpage_url || data.url || data.post_url || data.original_url || null;
        if (title || href) return { title, href };
      } catch {}
    }
  } catch {}
  return { title: null, href: null };
}

function buildCaption({ title, href, fallbackUrl, fileName }) {
  const t = title || fileName || 'وسائط محمّلة';
  const link = href || fallbackUrl;
  let caption = `🎬 <b>${escapeHtml(t)}</b>`;
  if (link) caption += `\n🔗 <a href="${escapeHtml(link)}">source</a>`;
  if (caption.length > 1000) caption = caption.slice(0, 980) + '...';
  return caption;
}

async function isVideoByProbe(filePath) {
  return await new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && out.toLowerCase().includes('video')));
  });
}

async function transcodeToTelegramMp4(inputPath) {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '') + '.tg.mp4';
  return await new Promise((resolve) => {
    log('ffmpeg:start', inputPath, '->', outputPath);
    const p = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=960:-2,fps=30',
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-preset', 'veryfast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '1',
      outputPath,
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      log('ffmpeg:close', code);
      if (code !== 0) log('ffmpeg:error', err.slice(-1200));
      resolve(code === 0 ? outputPath : null);
    });
  });
}

async function remuxToMp4(inputPath) {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '') + '.remux.mp4';
  return await new Promise((resolve) => {
    log('ffmpeg:remux:start', inputPath, '->', outputPath);
    const p = spawn('ffmpeg', ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      log('ffmpeg:remux:close', code);
      if (code !== 0) log('ffmpeg:remux:error', err.slice(-1200));
      resolve(code === 0 ? outputPath : null);
    });
  });
}

async function compressToUnderLimit(inputPath, targetMB = 48) {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '') + `.small.mp4`;
  const targetBits = Math.max(600_000, Math.floor((targetMB * 1024 * 1024 * 8) / 60));
  return await new Promise((resolve) => {
    log('ffmpeg:small:start', inputPath, '->', outputPath, 'targetMB=', targetMB);
    const p = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', 'scale=720:-2,fps=24',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-maxrate', `${Math.floor(targetBits/1000)}k`, '-bufsize', `${Math.floor(targetBits/500)}k`,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      outputPath,
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      log('ffmpeg:small:close', code);
      if (code !== 0) log('ffmpeg:small:error', err.slice(-1200));
      resolve(code === 0 ? outputPath : null);
    });
  });
}

async function transcodeProfile(inputPath, profile = 'hd') {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '') + `.${profile}.mp4`;
  const profiles = {
    hd: ['-vf', 'scale=1280:-2,fps=30', '-crf', '23', '-b:a', '128k'],
    sd: ['-vf', 'scale=854:-2,fps=24', '-crf', '30', '-b:a', '96k'],
    lq: ['-vf', 'scale=1920:-2,fps=30', '-crf', '18', '-b:a', '160k'],
  };
  const cfg = profiles[profile] || profiles.hd;
  return await new Promise((resolve) => {
    log('ffmpeg:profile:start', profile, inputPath, '->', outputPath);
    const p = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      ...cfg,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-ac', '2',
      outputPath,
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      log('ffmpeg:profile:close', profile, code);
      if (code !== 0) log('ffmpeg:profile:error', err.slice(-1200));
      resolve(code === 0 ? outputPath : null);
    });
  });
}

async function getVideoMeta(filePath) {
  return await new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      filePath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve({}));
    p.on('close', (code) => {
      if (code !== 0) return resolve({});
      try {
        const j = JSON.parse(out || '{}');
        const s = (j.streams && j.streams[0]) || {};
        const duration = Math.round(parseFloat((j.format || {}).duration || '0'));
        resolve({
          duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
          width: s.width || undefined,
          height: s.height || undefined,
        });
      } catch {
        resolve({});
      }
    });
  });
}

async function createVideoThumbnail(inputPath) {
  const outputPath = inputPath.replace(/\.[^/.]+$/, '') + '.thumb.jpg';
  return await new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-y',
      '-ss', '00:00:01',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-1',
      outputPath,
    ]);
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(outputPath) ? outputPath : null));
  });
}

async function scrapeMediaLinks(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  const html = await res.text();
  return extractMediaLinks(html);
}

async function runCommandLogged(bin, commandArgs = [], timeoutMs = 180000) {
  return await new Promise((resolve) => {
    log('cmd:start', bin, commandArgs.join(' '));
    const proc = spawn(bin, commandArgs, { env: process.env });
    let err = '';
    let out = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      log('cmd:timeout', bin, timeoutMs);
      resolve({ code: 124, err: `timeout after ${timeoutMs}ms`, out, tool: bin });
    }, timeoutMs);
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      log('cmd:error', bin, String(e?.message || e));
      resolve({ code: 127, err: String(e?.message || e), out, tool: bin });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      log('cmd:close', bin, 'code=', code);
      resolve({ code, err, out, tool: bin });
    });
  });
}

async function extractUrlsCount(url) {
  const args = [
    '--simulate', '--get-url',
    '-X', '/app/extractors',
    '-o', 'extractor.module-sources=/app/extractors',
  ];
  if (API_ID) args.push('-o', `extractor.telegram.api-id=${API_ID}`);
  if (API_HASH) args.push('-o', `extractor.telegram.api-hash=${API_HASH}`);
  if (STRING_SESSION) args.push('-o', `extractor.telegram.session=${STRING_SESSION}`);
  args.push(url);
  const r = await runCommandLogged('gallery-dl', args, 120000);
  const lines = (r.out || '').split('\n').map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
  const unique = [...new Set(lines)];
  log('urls:extracted', unique.length);
  return { code: r.code, count: unique.length, err: r.err || '' };
}

async function downloadToJob(url, jobDir) {
  const args = [
    '-D', jobDir,
    '--write-metadata',
    '--no-mtime',
    '-X', '/app/extractors',
    '-o', 'extractor.module-sources=/app/extractors',
  ];
  if (API_ID) args.push('-o', `extractor.telegram.api-id=${API_ID}`);
  if (API_HASH) args.push('-o', `extractor.telegram.api-hash=${API_HASH}`);
  if (STRING_SESSION) args.push('-o', `extractor.telegram.session=${STRING_SESSION}`);
  args.push(url);

  let result = await runCommandLogged('gallery-dl', args);
  log('gallery-dl:result', result.code);
  if (result.code !== 0) log('gallery-dl:stderr', (result.err || '').slice(-1200));

  if (result.code === 127) {
    result = await runCommandLogged('python3', ['-m', 'gallery_dl', ...args]);
    log('gallery-dl(py):result', result.code);
  }

  const partialFiles = walk(jobDir).filter((f) => isSendableFile(f));
  if (result.code === 124 && partialFiles.length > 0) {
    result = { code: 0, err: '', tool: 'gallery-dl(partial)' };
  }

  if (result.code !== 0) {
    const ytdlpOut = path.join(jobDir, '%(title).80s [%(id)s].%(ext)s');
    const ytdlpArgs = ['--no-playlist', '-o', ytdlpOut, url];
    const ytdlpResult = await runCommandLogged('yt-dlp', ytdlpArgs);
    log('yt-dlp:result', ytdlpResult.code);
    if (ytdlpResult.code === 0) result = { code: 0, err: '', tool: 'yt-dlp' };
    else result = ytdlpResult;
  }

  const files = walk(jobDir).filter((f) => isSendableFile(f));
  return { result, files };
}

async function telethonSendVideo(chatId, videoPath, caption, duration, thumbPath) {
  return await new Promise((resolve) => {
    const pyBin = fs.existsSync('/opt/py/bin/python') ? '/opt/py/bin/python' : 'python3';
    const proc = spawn(pyBin, [
      '/app/telethon_send.py',
      String(chatId),
      videoPath,
      caption,
      String(duration || ''),
      String(thumbPath || ''),
    ], { env: process.env });
    let perr = '';
    proc.stderr.on('data', (d) => (perr += d.toString()));
    proc.on('error', (e) => { log('telethon:spawn:error', e?.message || String(e)); resolve(false); });
    proc.on('close', (code) => {
      if (code !== 0) log('telethon:error', perr.slice(-1000));
      resolve(code === 0);
    });
  });
}

function detectSourceUrlForFile(filePath, fallbackUrl) {
  try {
    const sidecar = `${filePath}.json`;
    if (fs.existsSync(sidecar)) {
      const j = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      return j.url || j.media_url || j.content_url || j.original || j.webpage_url || fallbackUrl;
    }
  } catch {}
  return fallbackUrl;
}

async function redownloadToTemp(mediaUrl) {
  const u = new URL(mediaUrl);
  const ext = path.extname(u.pathname || '').toLowerCase() || '.mp4';
  const out = path.join(os.tmpdir(), `redo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  const res = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(out, Buffer.from(ab));
  return out;
}

async function sendMediaFile(chatId, filePath, caption, mode = 's', inlineKeyboard = null) {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
  const videoExts = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.m4s', '.ts'];

  if (imageExts.includes(ext)) {
    await bot.sendPhoto(chatId, filePath, { caption, parse_mode: 'HTML' });
    return { ok: true, kind: 'photo' };
  }

  const looksVideo = videoExts.includes(ext) || await isVideoByProbe(filePath);
  if (!looksVideo) return { ok: false, kind: 'other' };

  if (mode === 'h') {
    for (const t of [1, 3, 5]) {
      const thumb = await new Promise((resolve) => {
        const out = filePath + `.shot${t}.jpg`;
        const p = spawn('ffmpeg', ['-y', '-ss', `00:00:0${t}`, '-i', filePath, '-frames:v', '1', '-vf', 'scale=720:-1', out]);
        p.on('close', (c) => resolve(c === 0 && fs.existsSync(out) ? out : null));
        p.on('error', () => resolve(null));
      });
      if (thumb) {
        await bot.sendPhoto(chatId, thumb, { caption, parse_mode: 'HTML' });
        try { fs.unlinkSync(thumb); } catch {}
      }
    }
    return { ok: true, kind: 'video' };
  }

  let source = filePath;
  if (mode === 'hd' || mode === 'sd' || mode === 'lq') {
    const prof = await transcodeProfile(filePath, mode);
    if (prof) source = prof;
  } else if (mode === 'c') {
    const c = await compressToUnderLimit(filePath, 48);
    if (c) source = c;
  } else if (mode === 't') {
    const out = filePath + '.trim.mp4';
    const trimmed = await new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-y', '-ss', '0', '-t', '30', '-i', filePath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart', out]);
      p.on('close', (code) => resolve(code === 0 && fs.existsSync(out) ? out : null));
      p.on('error', () => resolve(null));
    });
    if (trimmed) source = trimmed;
  }

  const meta = await getVideoMeta(source);
  const thumb = await createVideoThumbnail(source);
  try {
    const sent = await bot.sendVideo(chatId, source, {
      caption,
      parse_mode: 'HTML',
      supports_streaming: true,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      thumb,
      reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
    });
    return { ok: true, kind: 'video', messageId: sent?.message_id };
  } catch (e) {
    const emsg = e?.message || String(e);
    log('send:video:error', emsg);

    if (/413|Request Entity Too Large/i.test(emsg)) {
      const smaller = await compressToUnderLimit(source, 45);
      if (smaller) {
        const m2 = await getVideoMeta(smaller);
        try {
          const sent2 = await bot.sendVideo(chatId, smaller, {
            caption,
            parse_mode: 'HTML',
            supports_streaming: true,
            duration: m2.duration,
            width: m2.width,
            height: m2.height,
            reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
          });
          try { fs.unlinkSync(smaller); } catch {}
          return { ok: true, kind: 'video', messageId: sent2?.message_id };
        } catch (e2) {
          log('send:video:small:error', e2?.message || String(e2));
        }
        try { fs.unlinkSync(smaller); } catch {}
      }
    }

    let ok = false;
    if (HAS_VALID_TELETHON_SESSION) {
      ok = await telethonSendVideo(chatId, source, caption, meta.duration, thumb);
    } else {
      log('telethon:skip', 'invalid or missing STRING_SESSION');
    }
    return { ok, kind: 'video' };
  } finally {
    if (thumb) { try { fs.unlinkSync(thumb); } catch {} }
    if (source !== filePath) { try { fs.unlinkSync(source); } catch {} }
  }
}

bot.onText(/^\/start$/, (msg) => {
  if (!isAllowed(msg)) return bot.sendMessage(msg.chat.id, 'غير مصرح لك.');
  bot.sendMessage(msg.chat.id, 'اهلا 👋\nارسل رابط وسأحمّله تلقائيًا عبر gallery-dl.');
});

bot.onText(/^\/help$/, (msg) => {
  if (!isAllowed(msg)) return bot.sendMessage(msg.chat.id, 'غير مصرح لك.');
  bot.sendMessage(msg.chat.id, 'فقط ارسل رابط مباشر يبدأ بـ http/https');
});

bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!isAllowed(msg)) return bot.sendMessage(msg.chat.id, 'غير مصرح لك.');

    const url = msg.text.trim();
    if (!isUrl(url)) return bot.sendMessage(msg.chat.id, 'ارسل رابط صحيح.');

    const preJobId = Math.random().toString(36).slice(2, 10);
    JOBS.set(preJobId, { pending: true, url, chatId: msg.chat.id, createdAt: Date.now() });
    await bot.sendMessage(msg.chat.id, '⚡ اختر الإجراء أولاً (قبل التحميل):', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Original', callback_data: `pre:${preJobId}:oq` }, { text: '🎬 HD', callback_data: `pre:${preJobId}:hd` }, { text: '📱 SD', callback_data: `pre:${preJobId}:sd` }],
          [{ text: '🗜 Compress', callback_data: `pre:${preJobId}:c` }, { text: '✨ Lossless', callback_data: `pre:${preJobId}:lq` }],
          [{ text: '🖼 Screenshots', callback_data: `pre:${preJobId}:h` }, { text: '✂️ Trim 30s', callback_data: `pre:${preJobId}:t` }],
          [{ text: '📚 Index Groups/Posts', callback_data: `pre:${preJobId}:idx` }],
        ],
      },
    });
    log('pre:menu', { jobId: preJobId, chat: msg.chat.id, url });
    return;

    const args = [
      '-D', jobDir,
      '--write-metadata',
      '--no-mtime',
      '-X', '/app/extractors',
      '-o', 'extractor.module-sources=/app/extractors',
    ];
    if (API_ID) args.push('-o', `extractor.telegram.api-id=${API_ID}`);
    if (API_HASH) args.push('-o', `extractor.telegram.api-hash=${API_HASH}`);
    if (STRING_SESSION) args.push('-o', `extractor.telegram.session=${STRING_SESSION}`);
    args.push(url);

    async function runCommand(bin, commandArgs = [], timeoutMs = 180000) {
      return await new Promise((resolve) => {
        log('cmd:start', bin, commandArgs.join(' '));
        const proc = spawn(bin, commandArgs, { env: process.env });
        let err = '';
        let out = '';
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          log('cmd:timeout', bin, timeoutMs);
          resolve({ code: 124, err: `timeout after ${timeoutMs}ms`, out, tool: bin });
        }, timeoutMs);
        proc.stderr.on('data', (d) => { err += d.toString(); });
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('error', (e) => {
          clearTimeout(timer);
          log('cmd:error', bin, String(e?.message || e));
          resolve({ code: 127, err: String(e?.message || e), out, tool: bin });
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          log('cmd:close', bin, 'code=', code);
          resolve({ code, err, out, tool: bin });
        });
      });
    }

    // 1) gallery-dl primary
    let result = await runCommand('gallery-dl', args);
    log('gallery-dl:result', result.code);
    if (result.code !== 0) log('gallery-dl:stderr', (result.err || '').slice(-1200));

    // 2) gallery-dl python fallback
    if (result.code === 127) {
      log('gallery-dl:fallback', 'python -m gallery_dl');
      result = await runCommand('python3', ['-m', 'gallery_dl', ...args]);
      log('gallery-dl(py):result', result.code);
    }

    // If gallery-dl timed out but produced files, continue with partial results
    const partialFiles = walk(jobDir).filter((f) => isSendableFile(f));
    if (result.code === 124 && partialFiles.length > 0) {
      log('gallery-dl:partial-after-timeout', partialFiles.length);
      result = { code: 0, err: '', tool: 'gallery-dl(partial)' };
    }

    // 3) yt-dlp fallback for unsupported links
    if (result.code !== 0) {
      await bot.sendMessage(msg.chat.id, '↪️ gallery-dl فشل، جاري المحاولة بـ yt-dlp...');
      const ytdlpOut = path.join(jobDir, '%(title).80s [%(id)s].%(ext)s');
      const ytdlpArgs = ['--no-playlist', '-o', ytdlpOut, url];
      const ytdlpResult = await runCommand('yt-dlp', ytdlpArgs);
      log('yt-dlp:result', ytdlpResult.code);

      if (ytdlpResult.code === 0) {
        result = { code: 0, err: '', tool: 'yt-dlp' };
      } else if (ytdlpResult.code === 127) {
        // python module fallback
        const ytdlpPy = await runCommand('python3', ['-m', 'yt_dlp', ...ytdlpArgs]);
        result = ytdlpPy.code === 0 ? { code: 0, err: '', tool: 'yt-dlp' } : { ...ytdlpPy, tool: 'yt-dlp(py)' };
      } else {
        result = { ...ytdlpResult, tool: 'yt-dlp' };
      }
    }

    if (result.code !== 0) {
      const errText = (result.err || 'download error').slice(-1200);

      if (/Unsupported URL/i.test(errText)) {
        try {
          const links = await scrapeMediaLinks(url);
          if (links.length) {
            let sent = 0;
            for (const link of links.slice(0, 8)) {
              const caption = buildCaption({ title: 'Media', href: link, fallbackUrl: url, fileName: null });
              try {
                if (/\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|m4s|ts)(\?|$)/i.test(link)) {
                  await bot.sendVideo(msg.chat.id, link, { caption, parse_mode: 'HTML' });
                } else if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(link)) {
                  await bot.sendPhoto(msg.chat.id, link, { caption, parse_mode: 'HTML' });
                } else {
                  await bot.sendMessage(msg.chat.id, `⏭️ تم تخطي رابط غير صورة/فيديو: ${link}`);
                }
              } catch {
                log('fallback:send-failed', link);
              }
              sent++;
            }
            await bot.sendMessage(msg.chat.id, `✅ تم عبر الوضع البديل. ارسلت ${sent} ملف/وسائط.`);
            fs.rmSync(jobDir, { recursive: true, force: true });
            return;
          }
        } catch (e) {
          // continue to default error below
        }
      }

      await bot.sendMessage(msg.chat.id, `❌ فشل التحميل (${result.tool || 'unknown'})\n${errText}`);
      fs.rmSync(jobDir, { recursive: true, force: true });
      return;
    }

    const files = walk(jobDir).filter((f) => isSendableFile(f));
    log('job:files', files.length);
    if (!files.length) {
      await bot.sendMessage(msg.chat.id, 'تم التنفيذ لكن لا توجد ملفات للإرسال.');
      fs.rmSync(jobDir, { recursive: true, force: true });
      return;
    }

    const idxJobId = Math.random().toString(36).slice(2, 8);
    const index = buildIndex(idxJobId, jobDir, files);
    const meta = findMetadata(jobDir);
    index.meta = meta;
    index.url = url;

    const rows = index.groups.map((g, i) => ([{ text: `📁 ${g.groupName} (${g.files.length})`, callback_data: `jg:${idxJobId}:${i}` }]));
    await bot.sendMessage(msg.chat.id, `✅ Indexed ${files.length} items. اختر مجموعة:`, { reply_markup: { inline_keyboard: rows } });
    log('job:indexed', { jobId: idxJobId, groups: index.groups.length, files: files.length });
  } catch (e) {
    log('job:error', e?.stack || e?.message || String(e));
    await bot.sendMessage(msg.chat.id, `❌ خطأ: ${e.message}`);
  }
});

bot.on('callback_query', async (q) => {
  try {
    const data = q.data || '';
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    const parts = data.split(':');
    const type = parts[0];

    if (type === 'pre') {
      const [, preJobId, mode] = parts;
      const pending = JOBS.get(preJobId);
      if (!pending?.pending) return bot.answerCallbackQuery(q.id, { text: 'job expired' });

      await bot.answerCallbackQuery(q.id, { text: 'starting download...' });
      await bot.sendMessage(chatId, '⏳ جاري التحميل حسب الخيار...');

      const jobDir = path.join(DOWNLOAD_DIR, `job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
      fs.mkdirSync(jobDir, { recursive: true });
      log('job:start', { chat: chatId, from: q.from?.id, url: pending.url, mode });
      log('job:dir', jobDir);

      await extractUrlsCount(pending.url);

      const { result, files } = await downloadToJob(pending.url, jobDir);
      if (result.code !== 0) {
        await bot.sendMessage(chatId, `❌ فشل التحميل (${result.tool || 'unknown'})\n${(result.err || '').slice(-1000)}`);
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
        JOBS.delete(preJobId);
        return;
      }

      if (!files.length) {
        await bot.sendMessage(chatId, 'تم التحميل لكن لا توجد ملفات.');
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
        JOBS.delete(preJobId);
        return;
      }

      if (mode === 'idx') {
        const idxJobId = Math.random().toString(36).slice(2, 8);
        const index = buildIndex(idxJobId, jobDir, files);
        const meta = findMetadata(jobDir);
        index.meta = meta;
        index.url = pending.url;
        const rows = index.groups.map((g, i) => ([{ text: `📁 ${g.groupName} (${g.files.length})`, callback_data: `jg:${idxJobId}:${i}:0` }]));
        await bot.sendMessage(chatId, `✅ Indexed ${files.length} items. اختر مجموعة:`, { reply_markup: { inline_keyboard: rows } });
      } else {
        const meta = findMetadata(jobDir);
        let sent = 0;
        for (const f of files.slice(0, 200)) {
          const cap = buildCaption({ title: meta.title, href: meta.href, fallbackUrl: pending.url, fileName: path.basename(f) });
          const sourceMediaUrl = detectSourceUrlForFile(f, pending.url);
          let keyboard = null;
          if ((await isVideoByProbe(f)) || /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|m4s|ts)$/i.test(path.extname(f))) {
            const token = Math.random().toString(36).slice(2, 10);
            ITEM_ACTIONS.set(token, { mediaUrl: sourceMediaUrl, fallbackUrl: pending.url, createdAt: Date.now() });
            keyboard = perVideoActionRows(token);
          }
          const res = await sendMediaFile(chatId, f, cap, mode, keyboard);
          if (res.ok) sent++;
          try { fs.unlinkSync(f); } catch {}
          try { fs.unlinkSync(`${f}.json`); } catch {}
        }
        await bot.sendMessage(chatId, `✅ done. sent=${sent}`);
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
      }
      JOBS.delete(preJobId);
      return;
    }

    if (type === 'jg') {
      const [, jobId, gIdxRaw, pageRaw] = parts;
      const gIdx = Number(gIdxRaw);
      const page = Number(pageRaw || 0);
      const job = JOBS.get(jobId);
      if (!job || !job.groups[gIdx]) return bot.answerCallbackQuery(q.id, { text: 'job expired' });
      const g = job.groups[gIdx];
      const pageSize = 8;
      const start = page * pageSize;
      const end = start + pageSize;
      const pagePosts = g.posts.slice(start, end);
      const postRows = pagePosts.map((p, i) => ([{ text: `🧩 Post ${p.postId} (${p.items.length})`, callback_data: `jp:${jobId}:${gIdx}:${start + i}:${page}` }]));
      const nav = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `jg:${jobId}:${gIdx}:${page - 1}` });
      if (end < g.posts.length) nav.push({ text: 'Next ➡️', callback_data: `jg:${jobId}:${gIdx}:${page + 1}` });
      const rows = [...postRows, ...(nav.length ? [nav] : []), ...actionRows(jobId, gIdx)];
      await bot.editMessageText(`📁 ${g.groupName}\nPosts: ${g.posts.length}\nFiles: ${g.files.length}\nPage: ${page + 1}`, {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: rows },
      });
      return bot.answerCallbackQuery(q.id);
    }

    if (type === 'jp') {
      const [, jobId, gIdxRaw, pIdxRaw, pageRaw] = parts;
      const gIdx = Number(gIdxRaw), pIdx = Number(pIdxRaw);
      const page = Number(pageRaw || 0);
      const job = JOBS.get(jobId);
      const post = job?.groups?.[gIdx]?.posts?.[pIdx];
      if (!post) return bot.answerCallbackQuery(q.id, { text: 'post not found' });
      const rows = [...actionRows(jobId, gIdx, pIdx), [{ text: '↩️ Back to group', callback_data: `jg:${jobId}:${gIdx}:${page}` }]];
      await bot.editMessageText(`🧩 Post ${post.postId}\nItems: ${post.items.length}`, {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: rows },
      });
      return bot.answerCallbackQuery(q.id);
    }

    if (type === 'va') {
      const [, token, mode] = parts;
      const item = ITEM_ACTIONS.get(token);
      if (!item) return bot.answerCallbackQuery(q.id, { text: 'media expired' });
      await bot.answerCallbackQuery(q.id, { text: 'processing selected video...' });

      const tmpDir = path.join(os.tmpdir(), `redo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        let localFile;
        if (/\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|m4s|ts)(\?|$)/i.test(item.mediaUrl)) {
          localFile = await redownloadToTemp(item.mediaUrl);
        } else {
          const { result, files } = await downloadToJob(item.fallbackUrl || item.mediaUrl, tmpDir);
          if (result.code !== 0 || !files.length) throw new Error('download failed for selected media');
          localFile = files.find((f) => /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|m4s|ts)$/i.test(path.extname(f))) || files[0];
        }
        const cap = buildCaption({ title: 'Processed', href: item.mediaUrl, fallbackUrl: item.fallbackUrl, fileName: path.basename(localFile) });
        const res = await sendMediaFile(chatId, localFile, cap, mode, perVideoActionRows(token));
        if (!res.ok) await bot.sendMessage(chatId, '❌ فشل تنفيذ العملية على الفيديو المحدد.');
        try { fs.unlinkSync(localFile); } catch {}
      } catch (e) {
        log('va:error', e?.message || String(e));
        await bot.sendMessage(chatId, `❌ تعذر تنفيذ العملية: ${e.message || e}`);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
      return;
    }

    if (type === 'ag' || type === 'ap') {
      const jobId = parts[1];
      const gIdx = Number(parts[2]);
      const mode = parts[type === 'ag' ? 3 : 4] || 's';
      const pIdx = type === 'ap' ? Number(parts[3]) : null;
      const job = JOBS.get(jobId);
      if (!job) return bot.answerCallbackQuery(q.id, { text: 'job expired' });

      const items = (type === 'ag')
        ? (job.groups[gIdx]?.files || [])
        : (job.groups[gIdx]?.posts?.[pIdx]?.items || []);

      await bot.answerCallbackQuery(q.id, { text: 'processing...' });
      await bot.sendMessage(chatId, `🚀 action=${mode} items=${items.length}`);

      let sent = 0;
      for (const f of items) {
        if (!fs.existsSync(f)) continue;
        const cap = buildCaption({
          title: job.meta?.title,
          href: job.meta?.href,
          fallbackUrl: job.url,
          fileName: path.basename(f),
        });
        const res = await sendMediaFile(chatId, f, cap, mode);
        if (res.ok) sent++;
      }

      await bot.sendMessage(chatId, `✅ done. sent=${sent}`);
      return;
    }

    if (type === 'clg') {
      const [, jobId, gIdxRaw] = parts;
      const gIdx = Number(gIdxRaw);
      const job = JOBS.get(jobId);
      const g = job?.groups?.[gIdx];
      if (!g) return bot.answerCallbackQuery(q.id, { text: 'group not found' });
      for (const f of g.files) {
        try { fs.unlinkSync(f); } catch {}
      }
      try { if (g.groupName !== '__root__') fs.rmSync(path.join(job.jobDir, g.groupName), { recursive: true, force: true }); } catch {}
      await bot.answerCallbackQuery(q.id, { text: 'group cleaned' });
      await bot.sendMessage(chatId, `🧹 cleaned group ${g.groupName}`);
      return;
    }
  } catch (e) {
    log('callback:error', e?.stack || e?.message || String(e));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/', (_, res) => res.send('gallery-dl bot is running'));
app.listen(PORT, () => console.log(`Health server on :${PORT}`));

console.log('Bot polling started');

if (ADMIN_CHAT_ID) {
  const startText = `✅ البوت اشتغل${process.env.DOKPLOY_APP_NAME ? ` (${process.env.DOKPLOY_APP_NAME})` : ''}`;
  bot.sendMessage(ADMIN_CHAT_ID, startText).catch(() => {});
}
