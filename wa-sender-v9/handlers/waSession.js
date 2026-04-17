// handlers/waSession.js — v9
//
// ═══════════════════════════════════════════════════════════════════
//  RISET MENDALAM v9: Mengapa Banner "AI dari Meta" Tidak Bisa
//  Ditrigger via Proto, dan Solusi Terbaik yang Tersedia
// ═══════════════════════════════════════════════════════════════════
//
//  ROOT CAUSE FINAL (setelah riset mendalam):
//  ────────────────────────────────────────────────────────────────
//
//  Banner "AI dari Meta menerima pesan untuk meningkatkan kualitas AI
//  dan membuat pesan untuk bisnis ini" (Image 2) adalah fitur
//  SERVER-SIDE dari WhatsApp, BUKAN proto field.
//
//  Banner ini HANYA muncul ketika:
//    1. Pengirim adalah akun WhatsApp Business RESMI
//    2. Akun bisnis tersebut mendaftarkan "Business AI" di
//       Meta Business Suite (whatsapp.com/business/ai)
//    3. WhatsApp SERVER yang menambahkan banner otomatis
//       saat penerima membuka chat pertama kali
//
//  KESIMPULAN: Tidak bisa direplikasi via Baileys karena:
//    - WhatsApp server mengontrol kapan banner ini muncul
//    - Tidak ada proto field yang bisa memicu banner ini
//    - Bahkan jika proto dimanipulasi, server WA akan strip field
//      yang tidak valid dari akun non-Business-API
//
//  ────────────────────────────────────────────────────────────────
//  SOLUSI TERBAIK YANG TERSEDIA DENGAN BAILEYS (v9):
//  ────────────────────────────────────────────────────────────────
//
//  1. FOOTER "ZAA SENDER" via interactiveMessage → ✅ BERHASIL (v8)
//     Tetap dipertahankan, pendekatan sudah benar.
//
//  2. AI BADGE (✦) via contextInfo.botMessageInvokerJid:
//     PERBEDAAN KRITIS yang menyebabkan v8 gagal:
//
//     v8 menggunakan: messageContextInfo.botMessageInvokedBy (proto nested)
//       → Field ini ada di LUAR message content
//       → Memerlukan proto.BotMessageInvokedBy.create() yang kompleks
//       → Sering di-strip oleh fromObject() pipeline
//
//     v9 menggunakan: contextInfo.botMessageInvokerJid (string field)
//       → Field ini ada di DALAM message content (ContextInfo proto)
//       → Cukup berupa string JID
//       → Baileys sendMessage() menerima contextInfo sebagai plain object
//       → Lebih reliable karena tidak melalui proto injection kompleks
//
//  3. FORMAT JID yang benar:
//     sock.user.id → contoh: "628xxx@s.whatsapp.net:2"
//     Harus digunakan TANPA modifikasi (termasuk device suffix)
//
//  STRUKTUR v9 yang benar:
//  ────────────────────────────────────────────────────────────────
//
//  M1. interactiveMessage + contextInfo.botMessageInvokerJid:
//    proto.Message.fromObject({
//      interactiveMessage: {
//        contextInfo: {                      ← ADA di sini, bukan di luar
//          botMessageInvokerJid: fromJid     ← string, bukan proto nested
//        },
//        body  : { text: message },
//        footer: { text: "ZAA SENDER" },
//        nativeFlowMessage: { messageVersion: true, buttons: [] }
//      }
//    })
//
//  M2. extendedTextMessage + contextInfo.botMessageInvokerJid
//
//  M3. plain sendMessage + contextInfo.botMessageInvokerJid (fallback)

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  generateWAMessageFromContent,
  proto
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import pino from 'pino'
import {
  upsertAccount,
  updateAccountStatus,
  getAllAccounts
} from '../db/database.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = join(__dirname, '..', 'sessions')

const activeSockets    = new Map()
const socketReadyState = new Map()
const pendingPairings  = new Map()

let globalStatusCallback = null
const logger = pino({ level: 'silent' })

async function ensureSessionDir(phone) {
  const dir = join(SESSIONS_DIR, phone)
  await mkdir(dir, { recursive: true })
  return dir
}

function getMsgFooter() {
  return process.env.MSG_FOOTER || 'ZAA SENDER'
}

export function isSocketReady(phone) {
  return socketReadyState.get(phone) === true
}
export function isConnected(phone) { return isSocketReady(phone) }
export function getActiveSockets() { return activeSockets }
export function setGlobalStatusCallback(cb) { globalStatusCallback = cb }

export function getSocketsDebugInfo() {
  return [...activeSockets.keys()].map(phone => ({
    phone,
    isReady: isSocketReady(phone)
  }))
}

// ─── Profile Branding ────────────────────────────────────────────

async function setupBotProfile(sock, phone) {
  const botName = process.env.BOT_NAME || 'ZAA SENDER'
  try {
    await sock.updateProfileName(botName)
    console.log(`[WA:${phone}] 🏷  Profile name → "${botName}"`)
  } catch (err) {
    console.warn(`[WA:${phone}] ⚠️  Gagal set profile name: ${err.message}`)
  }

  const logoCandidates = [
    process.env.BOT_LOGO_PATH,
    join(__dirname, '..', 'sessions', 'zaa-logo.png'),
    join(__dirname, '..', 'sessions', 'zaa-logo.jpg')
  ].filter(Boolean)

  for (const p of logoCandidates) {
    if (p && existsSync(p)) {
      try {
        const logoBuffer = await readFile(p)
        await sock.updateProfilePicture(sock.user.id, logoBuffer)
        console.log(`[WA:${phone}] ✅ Foto profil updated → ${botName}`)
        break
      } catch { /* skip */ }
    }
  }
}

// ─── Core: createWASession ────────────────────────────────────────

export async function createWASession(phone, onStatusChange = null) {
  if (activeSockets.has(phone) && isSocketReady(phone)) {
    console.log(`[WA:${phone}] Socket sudah aktif dan ready.`)
    return activeSockets.get(phone)
  }

  const sessionDir = await ensureSessionDir(phone)
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  socketReadyState.set(phone, false)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys : makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal             : false,
    generateHighQualityLinkPreview: false,
    syncFullHistory               : false,
    markOnlineOnConnect           : false,
    connectTimeoutMs              : 60_000,
    defaultQueryTimeoutMs         : 60_000,
    keepAliveIntervalMs           : 30_000,
    browser                       : ['Ubuntu', 'Chrome', '20.0.04'],
    msgRetryCounterMap            : {}
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    const cb = onStatusChange || globalStatusCallback

    if (connection === 'close') {
      const statusCode      = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[WA:${phone}] Koneksi terputus. Code: ${statusCode}. Reconnect: ${shouldReconnect}`)
      socketReadyState.set(phone, false)
      activeSockets.delete(phone)

      if (shouldReconnect) {
        await updateAccountStatus(phone, 'disconnected')
        cb?.(phone, 'disconnected', { statusCode })
        setTimeout(async () => {
          console.log(`[WA:${phone}] Mencoba reconnect...`)
          await createWASession(phone, cb)
        }, 5_000)
      } else {
        await updateAccountStatus(phone, 'logged_out')
        cb?.(phone, 'logged_out', {})
        socketReadyState.delete(phone)
      }
    }

    if (connection === 'open') {
      console.log(`[WA:${phone}] ✅ Terhubung dan READY!`)
      await updateAccountStatus(phone, 'connected')
      activeSockets.set(phone, sock)
      socketReadyState.set(phone, true)
      cb?.(phone, 'connected', {})

      if (pendingPairings.has(phone)) {
        pendingPairings.get(phone)?.({ success: true, phone })
        pendingPairings.delete(phone)
      }

      setTimeout(() => {
        setupBotProfile(sock, phone).catch(err =>
          console.warn(`[WA:${phone}] setupBotProfile error: ${err.message}`)
        )
      }, 3_000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue
      try {
        await sock.readMessages([msg.key])
        console.log(`[WA:${phone}] 👁  Auto-read dari ${msg.key.remoteJid}`)
      } catch (err) {
        console.warn(`[WA:${phone}] ⚠️  Gagal auto-read: ${err.message}`)
      }
    }
  })

  activeSockets.set(phone, sock)
  return sock
}

// ─── Request Pairing Code ─────────────────────────────────────────

export async function requestPairingCode(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '')
  console.log(`[WA:${cleanPhone}] Meminta pairing code...`)
  const sock = await createWASession(cleanPhone, globalStatusCallback)
  await new Promise(resolve => setTimeout(resolve, 3_000))
  const code      = await sock.requestPairingCode(cleanPhone)
  const formatted = code?.match(/.{1,4}/g)?.join('-') || code
  await upsertAccount(cleanPhone, { status: 'pending', pairingCode: formatted })
  console.log(`[WA:${cleanPhone}] Kode Pairing: ${formatted}`)
  return { code: formatted, phone: cleanPhone }
}

// ═══════════════════════════════════════════════════════════════════
//  sendMessage v9 — Footer + AI Badge dengan pendekatan YANG BENAR
//
//  PERBEDAAN vs v8:
//  v8: inject ke messageContextInfo.botMessageInvokedBy (luar message)
//      → Field proto nested, sering di-strip, tidak reliable
//
//  v9: inject ke interactiveMessage.contextInfo.botMessageInvokerJid
//      → String field DALAM message content, reliable
//      → Baileys menerima ini sebagai plain object tanpa proto injection
//
//  METODE (diurutkan dari terbaik ke fallback):
//  M1: interactiveMessage + contextInfo.botMessageInvokerJid (footer + AI badge)
//  M2: extendedTextMessage + contextInfo.botMessageInvokerJid (AI badge, no footer)
//  M3: plain sendMessage + contextInfo.botMessageInvokerJid (fallback)
//  M4: plain sendMessage tanpa badge (last resort)
// ═══════════════════════════════════════════════════════════════════

export async function sendMessage(fromPhone, toPhone, message) {
  const sock = activeSockets.get(fromPhone)

  if (!sock) {
    console.warn(`[WA:${fromPhone}] Socket tidak ditemukan, skip → ${toPhone}`)
    return false
  }
  if (!isSocketReady(fromPhone)) {
    console.warn(`[WA:${fromPhone}] Socket belum ready, skip → ${toPhone}`)
    return false
  }

  const toJid   = `${toPhone}@s.whatsapp.net`
  const fromJid = sock.user?.id ?? `${fromPhone}@s.whatsapp.net`
  const footer  = getMsgFooter()

  // ─────────────────────────────────────────────────────────────────
  // METODE 1: interactiveMessage + contextInfo.botMessageInvokerJid
  //
  // FIX v9 KEY CHANGE:
  //   contextInfo ada DI DALAM interactiveMessage (bukan di-inject dari luar)
  //   botMessageInvokerJid adalah string field, bukan proto nested message
  // ─────────────────────────────────────────────────────────────────
  try {
    const waMsg = generateWAMessageFromContent(
      toJid,
      proto.Message.fromObject({
        interactiveMessage: {
          // FIX v9: contextInfo DI DALAM interactiveMessage
          // botMessageInvokerJid adalah field string di ContextInfo proto
          // Ini berbeda dari messageContextInfo.botMessageInvokedBy (v8 salah)
          contextInfo: {
            botMessageInvokerJid: fromJid   // ← String, bukan proto nested
          },
          body  : { text: message },
          footer: { text: footer },
          nativeFlowMessage: {
            messageVersion: true,
            buttons        : []
          }
        }
      }),
      {
        userJid  : fromJid,
        timestamp: new Date()
      }
    )

    await sock.relayMessage(toJid, waMsg.message, { messageId: waMsg.key.id })
    console.log(
      `[WA] ✉️ [footer+AI] ${fromPhone} → ${toPhone}: ` +
      `"${message.substring(0, 35)}${message.length > 35 ? '...' : ''}" | "${footer}"`
    )
    return true

  } catch (err1) {
    console.warn(`[WA:${fromPhone}] M1 gagal (${err1.message}) → M2...`)
  }

  // ─────────────────────────────────────────────────────────────────
  // METODE 2: extendedTextMessage + contextInfo.botMessageInvokerJid
  // ─────────────────────────────────────────────────────────────────
  try {
    const waMsg2 = generateWAMessageFromContent(
      toJid,
      proto.Message.fromObject({
        extendedTextMessage: {
          text       : message,
          contextInfo: {
            botMessageInvokerJid: fromJid
          }
        }
      }),
      { userJid: fromJid, timestamp: new Date() }
    )

    await sock.relayMessage(toJid, waMsg2.message, { messageId: waMsg2.key.id })
    console.log(
      `[WA] ✉️ [AI] ${fromPhone} → ${toPhone}: ` +
      `"${message.substring(0, 35)}${message.length > 35 ? '...' : ''}" (no footer)`
    )
    return true

  } catch (err2) {
    console.warn(`[WA:${fromPhone}] M2 gagal (${err2.message}) → M3...`)
  }

  // ─────────────────────────────────────────────────────────────────
  // METODE 3: plain sendMessage + contextInfo.botMessageInvokerJid
  // Baileys sendMessage() menerima contextInfo sebagai plain object
  // tanpa perlu proto.Message.fromObject()
  // ─────────────────────────────────────────────────────────────────
  try {
    await sock.sendMessage(toJid, {
      text       : message,
      contextInfo: {
        botMessageInvokerJid: fromJid
      }
    })
    console.log(
      `[WA] ✉️ [AI-plain] ${fromPhone} → ${toPhone}: ` +
      `"${message.substring(0, 35)}${message.length > 35 ? '...' : ''}"`
    )
    return true

  } catch (err3) {
    console.warn(`[WA:${fromPhone}] M3 gagal (${err3.message}) → M4 (plain)...`)
  }

  // ─────────────────────────────────────────────────────────────────
  // METODE 4: plain sendMessage tanpa badge (last resort)
  // ─────────────────────────────────────────────────────────────────
  try {
    await sock.sendMessage(toJid, { text: message })
    console.log(
      `[WA] ✉️ [plain] ${fromPhone} → ${toPhone}: ` +
      `"${message.substring(0, 35)}${message.length > 35 ? '...' : ''}"`
    )
    return true

  } catch (err4) {
    console.error(`[WA] ❌ Gagal kirim ${fromPhone} → ${toPhone}: ${err4.message}`)
    const isConnErr = (
      err4.message?.includes('Connection Closed') ||
      err4.message?.includes('timed out')         ||
      err4.message?.includes('Stream Errored')
    )
    if (isConnErr) {
      socketReadyState.set(fromPhone, false)
      await updateAccountStatus(fromPhone, 'disconnected')
    }
    return false
  }
}

// ─── Reconnect all accounts on startup ───────────────────────────

export async function reconnectAllAccounts(onStatusChange = null) {
  if (onStatusChange) globalStatusCallback = onStatusChange
  const accounts    = await getAllAccounts()
  const toReconnect = accounts.filter(a => a.status !== 'logged_out')
  if (toReconnect.length === 0) {
    console.log('[WA] Tidak ada akun untuk di-reconnect.')
    return
  }
  console.log(`[WA] Reconnecting ${toReconnect.length} akun...`)
  for (const acc of toReconnect) {
    try {
      await createWASession(acc.phone, onStatusChange)
      await new Promise(r => setTimeout(r, 2_000))
    } catch (err) {
      console.error(`[WA] Gagal reconnect ${acc.phone}: ${err.message}`)
    }
  }
}

// ─── Disconnect ───────────────────────────────────────────────────

export async function disconnectSession(phone) {
  const sock = activeSockets.get(phone)
  if (sock) {
    try { await sock.logout() } catch { /* ignore */ }
    activeSockets.delete(phone)
    socketReadyState.delete(phone)
  }
  await updateAccountStatus(phone, 'logged_out')
}
