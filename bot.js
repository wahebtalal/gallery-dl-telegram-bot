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

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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

    await bot.sendMessage(msg.chat.id, '⏳ جاري التحميل...');
    log('job:start', { chat: msg.chat.id, from: msg.from?.id, url });

    const jobDir = path.join(DOWNLOAD_DIR, `job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    fs.mkdirSync(jobDir, { recursive: true });
    log('job:dir', jobDir);

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
    const partialFiles = walk(jobDir).filter((f) => !f.endsWith('.json'));
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
                await bot.sendMessage(msg.chat.id, link);
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

    const files = walk(jobDir).filter((f) => !f.endsWith('.json'));
    log('job:files', files.length);
    if (!files.length) {
      await bot.sendMessage(msg.chat.id, 'تم التنفيذ لكن لا توجد ملفات للإرسال.');
      fs.rmSync(jobDir, { recursive: true, force: true });
      return;
    }

    const meta = findMetadata(jobDir);

    let sent = 0;
    const groups = groupFilesByTopFolder(jobDir, files);

    for (const [groupName, groupFiles] of groups.entries()) {
      await bot.sendMessage(msg.chat.id, `📦 batch: ${groupName} (${groupFiles.length})`);
      for (const f of groupFiles.slice(0, 30)) {
        const size = fs.statSync(f).size / (1024 * 1024);
        const ext = path.extname(f).toLowerCase();

        if (size > 49 && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          await bot.sendMessage(msg.chat.id, `⚠️ تخطيت صورة كبيرة: ${path.basename(f)} (${size.toFixed(1)}MB)`);
          continue;
        }
        const caption = buildCaption({
          title: meta.title,
          href: meta.href,
          fallbackUrl: url,
          fileName: path.basename(f),
        });

        const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
        const videoExts = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg', '.m4s', '.ts'];

        if (imageExts.includes(ext)) {
          log('send:photo', f);
          await bot.sendPhoto(msg.chat.id, f, { caption, parse_mode: 'HTML' });
          sent++;
        } else {
          const looksVideo = videoExts.includes(ext) || await isVideoByProbe(f);
          log('send:classify', { file: f, ext, looksVideo });
          if (looksVideo) {
            const sendAsVideo = async (videoPath) => {
              const meta = await getVideoMeta(videoPath);
              const thumbPath = await createVideoThumbnail(videoPath);
              const opts = { caption, parse_mode: 'HTML', supports_streaming: true };
              if (meta.duration) opts.duration = meta.duration;
              if (meta.width) opts.width = meta.width;
              if (meta.height) opts.height = meta.height;
              if (thumbPath) opts.thumb = thumbPath;
              try {
                log('send:video', videoPath, meta);
                await bot.sendVideo(msg.chat.id, videoPath, opts);
                return true;
              } catch (e) {
                log('send:video:error', e?.message || String(e));
                const telethonOk = await new Promise((resolve) => {
                  const pyBin = fs.existsSync('/opt/py/bin/python') ? '/opt/py/bin/python' : 'python3';
                  const proc = spawn(pyBin, [
                    '/app/telethon_send.py',
                    String(msg.chat.id),
                    videoPath,
                    caption,
                    String(meta.duration || ''),
                    String(thumbPath || ''),
                  ], { env: process.env });
                  let perr = '';
                  let pout = '';
                  proc.stderr.on('data', (d) => (perr += d.toString()));
                  proc.stdout.on('data', (d) => (pout += d.toString()));
                  proc.on('error', (e) => {
                    log('telethon:spawn:error', e?.message || String(e));
                    resolve(false);
                  });
                  proc.on('close', (code) => {
                    if (code !== 0) {
                      log('telethon:error', perr.slice(-1000));
                      log('telethon:out', pout.slice(-500));
                    }
                    resolve(code === 0);
                  });
                });
                return telethonOk;
              } finally {
                if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
              }
            };

            let ok = false;
            let converted = await transcodeToTelegramMp4(f);
            if (!converted) converted = await remuxToMp4(f);
            if (converted && fs.existsSync(converted)) {
              let candidate = converted;
              const cSize = fs.statSync(candidate).size / (1024 * 1024);
              if (cSize > 49) {
                const smaller = await compressToUnderLimit(candidate, 48);
                if (smaller && fs.existsSync(smaller)) {
                  try { fs.unlinkSync(candidate); } catch {}
                  candidate = smaller;
                }
              }
              ok = await sendAsVideo(candidate);
              try { fs.unlinkSync(candidate); } catch {}
            }

            if (ok) sent++;
            else await bot.sendMessage(msg.chat.id, `⏭️ تعذر إرساله كوسائط حتى بعد التحويل/الضغط: ${path.basename(f)}`);
          } else {
            await bot.sendMessage(msg.chat.id, `⏭️ تخطيته لأنه ليس صورة/فيديو: ${path.basename(f)}`);
          }
        }

        try { fs.unlinkSync(f); } catch {}
      }

      if (groupName !== '__root__') {
        try { fs.rmSync(path.join(jobDir, groupName), { recursive: true, force: true }); } catch {}
      }
    }

    await bot.sendMessage(msg.chat.id, `✅ تم إرسال ${sent} وسائط.`);
    log('job:done', { sent, chat: msg.chat.id });
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (e) {
    log('job:error', e?.stack || e?.message || String(e));
    await bot.sendMessage(msg.chat.id, `❌ خطأ: ${e.message}`);
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
