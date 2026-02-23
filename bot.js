const TelegramBot = require('node-telegram-bot-api');
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

    const proc = spawn('gallery-dl', args, { env: process.env });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));

    const code = await new Promise((resolve) => proc.on('close', resolve));
    if (code !== 0) {
      await bot.sendMessage(msg.chat.id, `❌ فشل التحميل\n${err.slice(-1200) || 'gallery-dl error'}`);
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

console.log('Bot polling started');
