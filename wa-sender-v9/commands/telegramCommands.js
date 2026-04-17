// commands/telegramCommands.js
// FIX: Update /status pakai readyAccounts, tambah /load_script & /debug_sockets

import {
  getAllAccounts,
  getConnectedAccounts,
  setMessage,
  setMessageVariants,
  removeAccount
} from '../db/database.js'
import {
  requestPairingCode,
  disconnectSession,
  isConnected,
  getSocketsDebugInfo
} from '../handlers/waSession.js'
import {
  startLoop,
  stopLoop,
  isLoopRunning,
  getLoopStats
} from '../handlers/loopEngine.js'
import {
  parseScript,
  getUniqueSpeakers,
  mapSpeakersToAccounts,
  buildMessageTemplates,
  previewScriptDistribution
} from '../handlers/scriptParser.js'
import { readFile, writeFile, unlink } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const userStates = new Map()

// Temporary file storage untuk script upload per user
const pendingScripts = new Map() // userId -> { content, filePath }

function isAllowed(userId) {
  const allowed = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim())
  return allowed.includes(String(userId))
}

export function authMiddleware(ctx, next) {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Akses ditolak. Kamu tidak terdaftar sebagai admin.')
  }
  return next()
}

function statusEmoji(status) {
  const map = { connected: '🟢', disconnected: '🔴', pending: '🟡', logged_out: '⚫' }
  return map[status] || '❓'
}

// ── /start ─────────────────────────────────────────────────────────
export async function cmdStart(ctx) {
  const menu = `
🤖 <b>WA Sender Bot</b>
━━━━━━━━━━━━━━━━━━━━━━
Bot untuk Cross-Messaging WhatsApp Multi-Session

<b>📋 Perintah Tersedia:</b>

📱 <b>Manajemen Akun</b>
├ /add_acc — Tambah & pairing akun WA baru
├ /list_acc — Lihat daftar akun & statusnya
└ /remove_acc — Hapus akun dari sistem

💬 <b>Pesan</b>
├ /set_msg — Atur template pesan manual
└ /load_script — Upload & distribusi Percakapan.txt ke akun

🔄 <b>Operasional</b>
├ /run — Mulai cross-messaging loop
├ /stop — Hentikan semua pengiriman
└ /status — Lihat statistik saat ini

🔧 <b>Debug</b>
└ /debug_sockets — Cek status socket tiap akun

━━━━━━━━━━━━━━━━━━━━━━
ℹ️ Minimal 2 akun harus terhubung untuk memulai loop.
  `.trim()
  await ctx.replyWithHTML(menu)
}

// ── /add_acc ───────────────────────────────────────────────────────
export async function cmdAddAcc(ctx) {
  userStates.set(ctx.from.id, { step: 'waiting_phone_add' })
  await ctx.replyWithHTML(
    '📱 <b>Tambah Akun WhatsApp</b>\n\n' +
    'Masukkan nomor telepon dengan format internasional:\n' +
    '<code>628123456789</code>\n\n' +
    '⚠️ Pastikan nomor sudah terdaftar di WhatsApp.'
  )
}

// ── /list_acc ──────────────────────────────────────────────────────
export async function cmdListAcc(ctx) {
  const accounts = await getAllAccounts()
  if (accounts.length === 0) {
    return ctx.reply('📭 Belum ada akun terdaftar.\nGunakan /add_acc untuk menambahkan.')
  }

  // FIX: Tampilkan ready state dari socketDebugInfo
  const debugInfo = getSocketsDebugInfo()
  const readyMap = new Map(debugInfo.map(d => [d.phone, d.isReady]))

  let text = '📱 <b>Daftar Akun WhatsApp</b>\n━━━━━━━━━━━━━━━━━━\n\n'
  accounts.forEach((acc, idx) => {
    const emoji = statusEmoji(acc.status)
    const socketStatus = acc.status === 'connected'
      ? (readyMap.get(acc.phone) ? ' 🟩<i>socket ready</i>' : ' 🟨<i>socket connecting</i>')
      : ''
    const added = new Date(acc.addedAt).toLocaleDateString('id-ID')
    text += `${idx + 1}. ${emoji} <code>${acc.phone}</code>${socketStatus}\n`
    text += `    Status: <b>${acc.status}</b> | Ditambah: ${added}\n\n`
  })

  const connected = accounts.filter(a => a.status === 'connected').length
  const ready = debugInfo.filter(d => d.isReady).length
  text += `━━━━━━━━━━━━━━━━━━\n✅ Connected: <b>${connected}/${accounts.length}</b> | 🟩 Ready: <b>${ready}</b>`
  await ctx.replyWithHTML(text)
}

// ── /remove_acc ────────────────────────────────────────────────────
export async function cmdRemoveAcc(ctx) {
  userStates.set(ctx.from.id, { step: 'waiting_phone_remove' })
  await ctx.replyWithHTML(
    '🗑️ <b>Hapus Akun WhatsApp</b>\n\n' +
    'Masukkan nomor telepon yang ingin dihapus:\n' +
    '<code>628123456789</code>'
  )
}

// ── /debug_sockets ─────────────────────────────────────────────────
export async function cmdDebugSockets(ctx) {
  const info = getSocketsDebugInfo()
  const accounts = await getAllAccounts()

  let text = '🔧 <b>Debug Socket Status</b>\n━━━━━━━━━━━━━━━━━━\n\n'

  if (info.length === 0) {
    text += '⚠️ Tidak ada socket aktif di memori.\n'
    text += 'Coba restart bot atau /add_acc ulang.\n'
  } else {
    for (const s of info) {
      const icon = s.isReady ? '🟩' : '🟨'
      text += `${icon} <code>${s.phone}</code>\n`
      text += `    Socket: <b>${s.isReady ? 'READY ✅' : 'NOT READY ⏳'}</b>\n\n`
    }
  }

  // Akun di DB tapi tidak ada socketnya
  const socketPhones = new Set(info.map(s => s.phone))
  const orphaned = accounts.filter(a => a.status === 'connected' && !socketPhones.has(a.phone))
  if (orphaned.length > 0) {
    text += '⚠️ <b>Akun connected di DB tapi tidak ada socketnya:</b>\n'
    orphaned.forEach(a => { text += `  • <code>${a.phone}</code>\n` })
    text += '\n<i>Kemungkinan belum reconnect. Tunggu otomatis atau restart bot.</i>\n'
  }

  await ctx.replyWithHTML(text)
}

// ── /load_script ───────────────────────────────────────────────────
// Flow:
//   1. User ketik /load_script
//   2. Bot minta kirim file .txt atau paste teks
//   3. Bot preview distribusi speaker → akun
//   4. User konfirmasi (ya/tidak)
//   5. Simpan ke DB
export async function cmdLoadScript(ctx) {
  const accounts = await getAllAccounts()

  if (accounts.length < 2) {
    return ctx.replyWithHTML(
      '❌ <b>Minimal 2 akun diperlukan.</b>\n\n' +
      'Gunakan /add_acc untuk menambahkan akun WhatsApp terlebih dahulu.'
    )
  }

  userStates.set(ctx.from.id, { step: 'load_script_waiting' })

  let text = '📄 <b>Load Script Percakapan</b>\n━━━━━━━━━━━━━━━━━━\n\n'
  text += 'Kirim file <b>.txt</b> atau <b>paste langsung</b> isi percakapanmu.\n\n'
  text += '<b>Format yang didukung:</b>\n'
  text += '<code>No1: Halo, apa kabar?\nNo2: Baik! Kamu?\nNo1: Alhamdulillah baik juga.</code>\n\n'
  text += `📱 Akun tersedia: <b>${accounts.length} akun</b>\n`
  accounts.forEach((a, i) => {
    text += `  ${i + 1}. <code>${a.phone}</code>\n`
  })
  text += '\n<i>Speaker akan di-mapping ke akun secara round-robin otomatis.</i>'

  await ctx.replyWithHTML(text)
}

// ── /set_msg ───────────────────────────────────────────────────────
function buildPairs(senders, accounts) {
  const pairs = []
  for (const sender of senders) {
    const receivers = accounts.filter(a => a.phone !== sender)
    for (const recv of receivers) {
      pairs.push({ from: sender, to: recv.phone })
    }
  }
  return pairs
}

async function promptCurrentPair(ctx, state) {
  const { pairs, pairIndex, savedMessages } = state
  const pair = pairs[pairIndex]
  const total = pairs.length

  let text = `💬 <b>Atur Template Pesan</b>\n`
  text += `<i>Pasangan ${pairIndex + 1} dari ${total}</i>\n`
  text += `━━━━━━━━━━━━━━━━━━\n\n`
  text += `📤 Pengirim : <code>${pair.from}</code>\n`
  text += `📥 Penerima : <code>${pair.to}</code>\n\n`

  if (savedMessages.length > 0) {
    const lastThree = savedMessages.slice(-3)
    text += `<b>✅ Baru disimpan:</b>\n`
    lastThree.forEach(m => {
      const preview = m.message.length > 25 ? m.message.slice(0, 25) + '…' : m.message
      text += `  • <code>${m.from}</code>→<code>${m.to}</code>: <i>${preview}</i>\n`
    })
    text += '\n'
  }

  text += `Ketik isi pesan untuk pasangan ini:\n`
  text += `<i>(ketik <code>skip</code> untuk melewati)</i>`

  await ctx.replyWithHTML(text)
}

async function showSummary(ctx, savedMessages, skipped) {
  let text = `✅ <b>Semua Template Selesai Diatur!</b>\n`
  text += `━━━━━━━━━━━━━━━━━━\n\n`

  if (savedMessages.length > 0) {
    text += `<b>📋 Template tersimpan (${savedMessages.length}):</b>\n\n`
    savedMessages.forEach((m, idx) => {
      const preview = m.message.length > 40 ? m.message.slice(0, 40) + '…' : m.message
      text += `${idx + 1}. <code>${m.from}</code> → <code>${m.to}</code>\n`
      text += `    <i>"${preview}"</i>\n\n`
    })
  }

  if (skipped > 0) {
    text += `⏭️ Dilewati: <b>${skipped}</b> pasangan (akan pakai pesan default)\n\n`
  }

  text += `Gunakan /run untuk memulai pengiriman.`
  await ctx.replyWithHTML(text)
}

export async function cmdSetMsg(ctx) {
  const accounts = await getAllAccounts()

  if (accounts.length === 0) {
    return ctx.reply('📭 Belum ada akun terdaftar.')
  }
  if (accounts.length < 2) {
    return ctx.reply('⚠️ Minimal 2 akun diperlukan untuk mengatur template pesan.')
  }

  userStates.set(ctx.from.id, { step: 'set_msg_choose_sender' })

  let text = '💬 <b>Atur Template Pesan</b>\n\n'
  text += '📤 Pilih nomor <b>pengirim utama</b>:\n\n'
  accounts.forEach((acc, idx) => {
    text += `${idx + 1}. <code>${acc.phone}</code> ${statusEmoji(acc.status)}\n`
  })
  text += '\n'
  text += '• Ketik nomor spesifik → atur pesan dari 1 akun saja\n'
  text += '• Ketik <code>all</code> → atur pesan dari <b>semua</b> akun\n\n'
  text += 'Contoh: <code>628123456789</code>'

  await ctx.replyWithHTML(text)
}

// ── /run ───────────────────────────────────────────────────────────
export async function cmdRun(ctx) {
  if (isLoopRunning()) {
    return ctx.replyWithHTML('▶️ Loop sudah berjalan!\nGunakan /status atau /stop.')
  }

  const result = await startLoop(ctx.chat.id, ctx.telegram ? { telegram: ctx.telegram } : null)

  if (result.success) {
    const accounts = await getConnectedAccounts()
    let text = '🚀 <b>Cross-Messaging Loop Aktif!</b>\n\n'
    text += '📱 <b>Akun aktif:</b>\n'
    accounts.forEach((acc, idx) => { text += `${idx + 1}. <code>${acc.phone}</code>\n` })
    text += '\n🔄 Rotasi pengirim aktif — 1 akun kirim per iterasi.\n'
    text += '⏸️ Gunakan /stop untuk menghentikan.'
    await ctx.replyWithHTML(text)
  } else {
    await ctx.replyWithHTML(`❌ ${result.message}`)
  }
}

// ── /stop ──────────────────────────────────────────────────────────
export async function cmdStop(ctx) {
  if (!isLoopRunning()) return ctx.reply('⏸️ Loop tidak sedang berjalan.')
  const result = await stopLoop()
  await ctx.replyWithHTML(
    result.success
      ? '⛔ <b>Loop Dihentikan</b>\nSemua pengiriman pesan telah berhenti.'
      : `❌ ${result.message}`
  )
}

// ── /status ────────────────────────────────────────────────────────
export async function cmdStatus(ctx) {
  const stats = await getLoopStats()
  const accounts = await getAllAccounts()
  const debugInfo = getSocketsDebugInfo()
  const connected = accounts.filter(a => a.status === 'connected')
  const readyCount = debugInfo.filter(d => d.isReady).length
  const runningEmoji = stats.isRunning ? '🟢 Berjalan' : '🔴 Berhenti'
  const lastRun = stats.lastRun ? new Date(stats.lastRun).toLocaleString('id-ID') : 'Belum pernah'

  let text = `📊 <b>Status WA Sender</b>\n━━━━━━━━━━━━━━━━━━\n\n`
  text += `🔄 Loop       : <b>${runningEmoji}</b>\n`
  text += `📱 DB Connected: <b>${connected.length}/${accounts.length}</b>\n`
  text += `🟩 Socket Ready: <b>${readyCount}/${accounts.length}</b>\n`
  text += `🔄 Putaran selesai : <b>${stats.totalRounds ?? 0}</b>\n`
  text += `📨 Total terkirim  : <b>${stats.totalSent ?? 0}</b>\n`
  text += `❌ Total gagal     : <b>${stats.totalFailed ?? 0}</b>\n`
  text += `⏰ Terakhir jalan  : <b>${lastRun}</b>\n\n`

  if (connected.length > 0) {
    const readyMap = new Map(debugInfo.map(d => [d.phone, d.isReady]))
    text += '<b>Akun Connected:</b>\n'
    connected.forEach((acc, idx) => {
      const readyIcon = readyMap.get(acc.phone) ? '🟩' : '🟨'
      text += `${idx + 1}. ${readyIcon} <code>${acc.phone}</code>\n`
    })
  }

  if (readyCount < connected.length) {
    text += `\n⚠️ <i>Beberapa socket belum ready. Tunggu beberapa saat.</i>`
  }

  await ctx.replyWithHTML(text)
}

// ── handleTextMessage: router semua state ─────────────────────────
export async function handleTextMessage(ctx) {
  const userId = ctx.from.id
  const text = ctx.message?.text?.trim()
  const state = userStates.get(userId)

  // ── HANDLE FILE UPLOAD (document) ────────────────────────────────
  // Ini ditangani di handleDocument, bukan di sini

  if (!state || !text) return

  // ── ADD ACC ──────────────────────────────────────────────────────
  if (state.step === 'waiting_phone_add') {
    const phone = text.replace(/[^0-9]/g, '')
    if (phone.length < 10) return ctx.reply('❌ Format nomor tidak valid. Contoh: 628123456789')
    userStates.delete(userId)
    await ctx.replyWithHTML(`⏳ Meminta pairing code untuk <code>${phone}</code>...`)
    try {
      const { code } = await requestPairingCode(phone)
      await ctx.replyWithHTML(
        `🔑 <b>Pairing Code Berhasil!</b>\n\n` +
        `📱 Nomor: <code>${phone}</code>\n` +
        `🔢 Kode: <code>${code}</code>\n\n` +
        `<b>Cara pairing:</b>\n` +
        `1. WhatsApp → Menu (⋮) → Linked Devices\n` +
        `2. Link a Device → "Link with phone number"\n` +
        `3. Masukkan: <code>${code}</code>\n\n` +
        `⏳ Menunggu konfirmasi...`
      )
    } catch (err) {
      await ctx.reply(`❌ Gagal pairing: ${err.message}`)
    }
    return
  }

  // ── REMOVE ACC ───────────────────────────────────────────────────
  if (state.step === 'waiting_phone_remove') {
    const phone = text.replace(/[^0-9]/g, '')
    userStates.delete(userId)
    try {
      await disconnectSession(phone)
      await removeAccount(phone)
      await ctx.replyWithHTML(`✅ Akun <code>${phone}</code> berhasil dihapus.`)
    } catch (err) {
      await ctx.reply(`❌ Gagal hapus: ${err.message}`)
    }
    return
  }

  // ── LOAD SCRIPT: STEP 1 — Terima paste teks langsung ─────────────
  if (state.step === 'load_script_waiting') {
    // User paste teks langsung (bukan file)
    await processScriptContent(ctx, text, userId)
    return
  }

  // ── LOAD SCRIPT: STEP 2 — Konfirmasi ─────────────────────────────
  if (state.step === 'load_script_confirm') {
    const answer = text.toLowerCase()
    if (answer === 'ya' || answer === 'y' || answer === 'yes') {
      await saveScriptToDatabase(ctx, userId)
    } else {
      userStates.delete(userId)
      pendingScripts.delete(userId)
      await ctx.reply('❌ Dibatalkan. Template tidak disimpan.')
    }
    return
  }

  // ── SET_MSG: STEP 1 — Pilih pengirim ─────────────────────────────
  if (state.step === 'set_msg_choose_sender') {
    const accounts = await getAllAccounts()
    const input = text.trim().toLowerCase()
    let senders = []

    if (input === 'all') {
      senders = accounts.map(a => a.phone)
    } else {
      const phone = text.replace(/[^0-9]/g, '')
      const exists = accounts.find(a => a.phone === phone)
      if (!exists) {
        let errText = `❌ Nomor <code>${phone}</code> tidak terdaftar.\n\nNomor tersedia:\n`
        accounts.forEach((a, i) => { errText += `${i + 1}. <code>${a.phone}</code>\n` })
        errText += '\nAtau ketik <code>all</code>'
        return ctx.replyWithHTML(errText)
      }
      senders = [phone]
    }

    const pairs = buildPairs(senders, accounts)
    if (pairs.length === 0) {
      userStates.delete(userId)
      return ctx.reply('⚠️ Tidak ada pasangan pesan yang bisa dibuat.')
    }

    const newState = {
      step: 'set_msg_input_message',
      senders,
      pairs,
      pairIndex: 0,
      savedMessages: [],
      skippedCount: 0
    }
    userStates.set(userId, newState)

    const senderLabel = input === 'all' ? `semua akun (${senders.length})` : senders[0]
    await ctx.replyWithHTML(
      `✅ Pengirim: <b>${senderLabel}</b>\n` +
      `📋 Total pasangan: <b>${pairs.length}</b>\n\n` +
      `Isi pesan untuk setiap pasangan di bawah ini 👇`
    )
    await promptCurrentPair(ctx, newState)
    return
  }

  // ── SET_MSG: STEP 2 — Input pesan per pasangan ───────────────────
  if (state.step === 'set_msg_input_message') {
    const { pairs, pairIndex, savedMessages } = state
    const currentPair = pairs[pairIndex]
    const isSkip = text.toLowerCase() === 'skip'

    if (!isSkip) {
      await setMessage(currentPair.from, currentPair.to, text)
      savedMessages.push({ from: currentPair.from, to: currentPair.to, message: text })
      await ctx.replyWithHTML(`✅ <code>${currentPair.from}</code> → <code>${currentPair.to}</code>`)
    } else {
      state.skippedCount = (state.skippedCount || 0) + 1
      await ctx.replyWithHTML(`⏭️ Skip: <code>${currentPair.from}</code> → <code>${currentPair.to}</code>`)
    }

    const nextIndex = pairIndex + 1
    if (nextIndex < pairs.length) {
      state.pairIndex = nextIndex
      userStates.set(userId, state)
      await promptCurrentPair(ctx, state)
    } else {
      userStates.delete(userId)
      await showSummary(ctx, savedMessages, state.skippedCount || 0)
    }
    return
  }
}

// ── HELPER: Proses konten script ──────────────────────────────────
async function processScriptContent(ctx, content, userId) {
  const accounts = await getAllAccounts()
  const phones = accounts.map(a => a.phone)

  const preview = await previewScriptDistribution(content, phones)

  if (preview.error) {
    userStates.delete(userId)
    return ctx.replyWithHTML(
      `❌ <b>Format tidak dikenali</b>\n\n${preview.error}\n\n` +
      `<b>Format yang benar:</b>\n<code>No1: teks pesan\nNo2: teks pesan</code>`
    )
  }

  // Simpan pending
  pendingScripts.set(userId, { content })

  // Tampilkan preview
  let text = `📋 <b>Preview Distribusi Script</b>\n━━━━━━━━━━━━━━━━━━\n\n`
  text += `📝 Total baris dialog: <b>${preview.totalLines}</b>\n`
  text += `🎭 Jumlah karakter (speaker): <b>${preview.speakers}</b>\n`
  text += `📨 Template pesan yg akan dibuat: <b>${preview.templates}</b>\n\n`
  text += `<b>Mapping Karakter → Akun WA:</b>\n`

  for (const p of preview.preview) {
    text += `\n🎭 <b>${p.speaker.toUpperCase()}</b> → <code>${p.mappedTo}</code>\n`
    for (const line of p.sampleLines) {
      const preview30 = line.length > 35 ? line.slice(0, 35) + '…' : line
      text += `  <i>"${preview30}"</i>\n`
    }
  }

  text += `\n━━━━━━━━━━━━━━━━━━\n`
  text += `Simpan ke database?\n`
  text += `Ketik <b>ya</b> untuk konfirmasi, atau <b>tidak</b> untuk batal.`

  userStates.set(userId, { step: 'load_script_confirm' })
  await ctx.replyWithHTML(text)
}

// ── HELPER: Simpan script ke DB ───────────────────────────────────
async function saveScriptToDatabase(ctx, userId) {
  const pending = pendingScripts.get(userId)
  if (!pending) {
    userStates.delete(userId)
    return ctx.reply('❌ Data script tidak ditemukan. Ulangi /load_script.')
  }

  userStates.delete(userId)
  pendingScripts.delete(userId)

  await ctx.replyWithHTML('⏳ Memproses dan menyimpan template...')

  try {
    const accounts = await getAllAccounts()
    const phones = accounts.map(a => a.phone)

    // Gunakan static import dari top-level — tidak perlu dynamic import ulang
    const dialogs     = parseScript(pending.content)
    const speakers    = getUniqueSpeakers(dialogs)
    const speakerMap  = mapSpeakersToAccounts(speakers, phones)
    const templates   = buildMessageTemplates(dialogs, speakerMap)

    let saved = 0
    for (const t of templates) {
      // FIX v4: gunakan setMessageVariants agar rotasi variant aktif
      if (t.variants && t.variants.length > 0) {
        await setMessageVariants(t.from, t.to, t.variants)
      } else if (t.message) {
        await setMessage(t.from, t.to, t.message)
      }
      saved++
    }

    // Ringkasan
    let text = `✅ <b>Script Berhasil Dimuat!</b>\n━━━━━━━━━━━━━━━━━━\n\n`
    text += `📝 Baris dialog: <b>${dialogs.length}</b>\n`
    text += `🎭 Karakter: <b>${speakers.length}</b>\n`
    text += `📨 Template tersimpan: <b>${saved}</b>\n\n`
    text += `<b>Mapping Final:</b>\n`

    for (const [speaker, phone] of speakerMap.entries()) {
      const count = dialogs.filter(d => d.speaker === speaker).length
      text += `  🎭 ${speaker.toUpperCase()} → <code>${phone}</code> (<b>${count} baris</b>)\n`
    }

    text += `\n<i>Gunakan /run untuk memulai pengiriman.</i>`
    await ctx.replyWithHTML(text)
  } catch (err) {
    await ctx.reply(`❌ Gagal menyimpan: ${err.message}`)
  }
}

// ── Handler untuk file document (upload .txt) ─────────────────────
export async function handleDocument(ctx) {
  const userId = ctx.from.id
  const state = userStates.get(userId)

  if (!state || state.step !== 'load_script_waiting') {
    return // Abaikan jika tidak sedang di step yang relevan
  }

  const doc = ctx.message?.document
  if (!doc) return

  // Cek ekstensi
  const fileName = doc.file_name || ''
  if (!fileName.endsWith('.txt')) {
    return ctx.reply('⚠️ Hanya file .txt yang didukung.')
  }

  try {
    await ctx.reply('⏳ Mengunduh file...')
    const fileLink = await ctx.telegram.getFileLink(doc.file_id)
    const response = await fetch(fileLink.href)

    // Validasi HTTP response sebelum baca body
    if (!response.ok) {
      return ctx.reply(
        `❌ Gagal mengunduh file dari Telegram (HTTP ${response.status}).\n` +
        `Coba kirim ulang file-nya.`
      )
    }

    // Guard ukuran file — cek Content-Length header jika tersedia
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    const MAX_SIZE = 500 * 1024 // 500 KB — script teks tidak perlu lebih besar
    if (contentLength > MAX_SIZE) {
      return ctx.reply(`❌ File terlalu besar (${Math.round(contentLength / 1024)} KB). Maksimal 500 KB.`)
    }

    const content = await response.text()

    if (!content.trim()) {
      return ctx.reply('❌ File kosong.')
    }

    await processScriptContent(ctx, content, userId)
  } catch (err) {
    await ctx.reply(`❌ Gagal membaca file: ${err.message}`)
  }
}
