// index.js
// Entry Point Utama — WA Sender Bot
// FIX: Register setGlobalStatusCallback, tambah /load_script & /debug_sockets

import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'

import { initDB, getSettings } from './db/database.js'
import { reconnectAllAccounts, setGlobalStatusCallback } from './handlers/waSession.js'
import { setTelegramRef, stopLoop } from './handlers/loopEngine.js'

import {
  authMiddleware,
  cmdStart,
  cmdAddAcc,
  cmdListAcc,
  cmdRemoveAcc,
  cmdSetMsg,
  cmdRun,
  cmdStop,
  cmdStatus,
  cmdLoadScript,
  cmdDebugSockets,
  handleTextMessage,
  handleDocument
} from './commands/telegramCommands.js'

// ─── VALIDASI ENV ─────────────────────────────────────────────────
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN tidak ditemukan di .env!')
  process.exit(1)
}

if (!process.env.ALLOWED_USERS) {
  console.error('❌ ALLOWED_USERS tidak ditemukan di .env!')
  process.exit(1)
}

// ─── INISIALISASI ─────────────────────────────────────────────────
console.log('╔══════════════════════════════════╗')
console.log('║     WA Sender — Cross Messaging  ║')
console.log('╚══════════════════════════════════╝\n')

// 1. Inisialisasi Database
console.log('[BOOT] Inisialisasi database...')
await initDB()

// 2. Inisialisasi Telegram Bot
console.log('[BOOT] Inisialisasi Telegram Bot...')
const bot = new Telegraf(process.env.BOT_TOKEN)

// ─── MIDDLEWARE ───────────────────────────────────────────────────
bot.use(authMiddleware)

// ─── COMMAND HANDLERS ─────────────────────────────────────────────
bot.command('start', cmdStart)
bot.command('add_acc', cmdAddAcc)
bot.command('list_acc', cmdListAcc)
bot.command('remove_acc', cmdRemoveAcc)
bot.command('set_msg', cmdSetMsg)
bot.command('load_script', cmdLoadScript)
bot.command('debug_sockets', cmdDebugSockets)
bot.command('run', async (ctx) => {
  setTelegramRef(bot, ctx.chat.id)
  await cmdRun(ctx)
})
bot.command('stop', cmdStop)
bot.command('status', cmdStatus)

// Handler untuk teks & file
bot.on(message('text'), handleTextMessage)
bot.on(message('document'), handleDocument)

// ─── ERROR HANDLER ────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[BOT] Error pada update ${ctx.updateType}:`, err.message)
  ctx.reply('⚠️ Terjadi error. Coba lagi atau periksa log.')
})

// ─── STATUS CALLBACK ──────────────────────────────────────────────
// FIX: Buat callback SEBELUM reconnect, lalu register ke waSession
const waStatusCallback = async (phone, status, data) => {
  console.log(`[WA] ${phone} → ${status}`)

  const allowedUsers = (process.env.ALLOWED_USERS || '').split(',')
  if (allowedUsers[0]) {
    try {
      const emoji = status === 'connected' ? '🟢' : status === 'disconnected' ? '🔴' : '🟡'
      await bot.telegram.sendMessage(
        allowedUsers[0].trim(),
        `${emoji} WA <code>${phone}</code> — <b>${status}</b>`,
        { parse_mode: 'HTML' }
      )
    } catch {
      // Silent — admin mungkin belum mulai chat dengan bot
    }
  }
}

// FIX: Register callback global SEBELUM reconnect agar requestPairingCode juga pakai callback ini
setGlobalStatusCallback(waStatusCallback)

// ─── RECONNECT SESI LAMA ──────────────────────────────────────────
console.log('[BOOT] Mencoba reconnect sesi WhatsApp yang tersimpan...')
reconnectAllAccounts(waStatusCallback).catch(err => {
  console.error('[BOOT] Error saat reconnect:', err.message)
})

// ─── RESUME LOOP JIKA SEBELUMNYA AKTIF ────────────────────────────
const settings = await getSettings()
if (settings.isRunning) {
  console.log('[BOOT] Loop sebelumnya aktif, menunggu WA siap sebelum resume...')
  setTimeout(async () => {
    const { startLoop } = await import('./handlers/loopEngine.js')
    const allowedUsers = (process.env.ALLOWED_USERS || '').split(',')
    const chatId = allowedUsers[0]?.trim()
    if (chatId) {
      setTelegramRef(bot, chatId)
      await startLoop(chatId, bot)
      console.log('[BOOT] Loop dilanjutkan otomatis.')
    }
  }, 15_000)
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────
process.once('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Menerima SIGINT...')
  await stopLoop().catch(() => {})
  bot.stop('SIGINT')
  process.exit(0)
})

process.once('SIGTERM', async () => {
  console.log('\n[SHUTDOWN] Menerima SIGTERM...')
  await stopLoop().catch(() => {})
  bot.stop('SIGTERM')
  process.exit(0)
})

// ─── MULAI BOT ────────────────────────────────────────────────────
console.log('[BOOT] Memulai Telegram Bot...')
await bot.launch()
console.log('\n✅ WA Sender Bot berhasil dijalankan!')
console.log(`📱 Bot aktif. Buka Telegram dan ketik /start`)
console.log(`👤 Admin yang diizinkan: ${process.env.ALLOWED_USERS}\n`)
