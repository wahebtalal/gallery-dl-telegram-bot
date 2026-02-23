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

function extractMediaLinks(html) {
  const normalized = String(html || '').replace(/\\\//g, '/');
  const re = /https?:\/\/[^\s"'<>]+\.(?:mp4|webm|m3u8|jpg|jpeg|png|gif|webp)(?:\?[^\s"'<>]*)?/gi;
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

    const jobDir = path.join(DOWNLOAD_DIR, `job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    fs.mkdirSync(jobDir, { recursive: true });

    const args = ['-D', jobDir, '--write-metadata', '--no-mtime'];
    if (API_ID) args.push('-o', `extractor.telegram.api-id=${API_ID}`);
    if (API_HASH) args.push('-o', `extractor.telegram.api-hash=${API_HASH}`);
    if (STRING_SESSION) args.push('-o', `extractor.telegram.session=${STRING_SESSION}`);
    args.push(url);

    async function runCommand(bin, commandArgs = []) {
      return await new Promise((resolve) => {
        const proc = spawn(bin, commandArgs, { env: process.env });
        let err = '';
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('error', (e) => resolve({ code: 127, err: String(e?.message || e), tool: bin }));
        proc.on('close', (code) => resolve({ code, err, tool: bin }));
      });
    }

    // 1) gallery-dl primary
    let result = await runCommand('gallery-dl', args);

    // 2) gallery-dl python fallback
    if (result.code === 127) {
      result = await runCommand('python3', ['-m', 'gallery_dl', ...args]);
    }

    // 3) yt-dlp fallback for unsupported links
    if (result.code !== 0) {
      const ytdlpOut = path.join(jobDir, '%(title).80s [%(id)s].%(ext)s');
      const ytdlpArgs = ['--no-playlist', '-o', ytdlpOut, url];
      const ytdlpResult = await runCommand('yt-dlp', ytdlpArgs);
      if (ytdlpResult.code === 127) {
        // python module fallback
        const ytdlpPy = await runCommand('python3', ['-m', 'yt_dlp', ...ytdlpArgs]);
        if (ytdlpPy.code === 0) result = { code: 0, err: '', tool: 'yt-dlp' };
      } else if (ytdlpResult.code === 0) {
        result = { code: 0, err: '', tool: 'yt-dlp' };
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
              try {
                await bot.sendDocument(msg.chat.id, link);
              } catch {
                await bot.sendMessage(msg.chat.id, link);
              }
              sent++;
            }
            await bot.sendMessage(msg.chat.id, `✅ تم عبر الوضع البديل. ارسلت ${sent} ملف/رابط.`);
            fs.rmSync(jobDir, { recursive: true, force: true });
            return;
          }
        } catch (e) {
          // continue to default error below
        }
      }

      await bot.sendMessage(msg.chat.id, `❌ فشل التحميل\n${errText}`);
      fs.rmSync(jobDir, { recursive: true, force: true });
      return;
    }

    const files = walk(jobDir).filter((f) => !f.endsWith('.json'));
    if (!files.length) {
      await bot.sendMessage(msg.chat.id, 'تم التنفيذ لكن لا توجد ملفات للإرسال.');
      fs.rmSync(jobDir, { recursive: true, force: true });
      return;
    }

    let sent = 0;
    for (const f of files.slice(0, 10)) {
      const size = fs.statSync(f).size / (1024 * 1024);
      if (size > 49) {
        await bot.sendMessage(msg.chat.id, `⚠️ تخطيت ملف كبير: ${path.basename(f)} (${size.toFixed(1)}MB)`);
        continue;
      }
      await bot.sendDocument(msg.chat.id, f, {}, { filename: path.basename(f) });
      sent++;
    }

    await bot.sendMessage(msg.chat.id, `✅ تم إرسال ${sent} ملف/ملفات.`);
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (e) {
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
