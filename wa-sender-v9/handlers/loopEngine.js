// handlers/loopEngine.js
// ALGORITMA: Shift Rotation Anti-Banned  (v4)
//
// FIX v4:
//   - Snapshot accounts di AWAL putaran, tidak re-fetch tiap shift
//     (mencegah akun hilang/muncul di tengah putaran menyebabkan
//      satu sisi tidak pernah kirim)
//   - Validasi simetri: pastikan setiap pasangan (A→B DAN B→A) punya
//     template sebelum putaran dimulai, warn jika tidak
//   - isSocketReady re-check tepat sebelum sendMessage (bukan hanya di awal)
//   - Tambah jitter kecil di micro delay agar pola waktu tidak terlalu reguler
//
// Prinsip kerja untuk N akun [A, B, C, D]:
//
//   shift=1:  A→B, B→C, C→D, D→A
//   shift=2:  A→C, B→D, C→A, D→B
//   shift=3:  A→D, B→A, C→B, D→C
//
// Total pesan per satu putaran penuh = N × (N-1)
// Setiap pasangan (from→to) unik, muncul tepat 1× per putaran.
// TIDAK ADA pengiriman paralel — semua await sekuensial.

import {
  getConnectedAccounts,
  getSettings,
  updateSettings,
  getMessage
} from '../db/database.js'
import { sendMessage, isSocketReady } from './waSession.js'

// ─── State Engine ─────────────────────────────────────────────────
let loopTimer       = null
let isEngineRunning = false
let totalRounds     = 0
let totalSent       = 0
let totalFailed     = 0

let telegramBot = null
let adminChatId = null

// ─── Helpers ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Delay bisa di-override via .env
const MICRO_MIN = () => parseInt(process.env.MICRO_DELAY_MIN ?? '12000')
const MICRO_MAX = () => parseInt(process.env.MICRO_DELAY_MAX ?? '35000')
const MACRO_MIN = () => parseInt(process.env.MACRO_DELAY_MIN ?? '60000')
const MACRO_MAX = () => parseInt(process.env.MACRO_DELAY_MAX ?? '120000')

export function setTelegramRef(bot, chatId) {
  telegramBot = bot
  adminChatId = chatId
}

async function notify(msg) {
  if (telegramBot && adminChatId) {
    try {
      await telegramBot.telegram.sendMessage(adminChatId, msg, { parse_mode: 'HTML' })
    } catch { /* silent */ }
  }
}

/**
 * Ambil akun yang DB-connected DAN socket ready di memori.
 *
 * PENTING: Fungsi ini di-snapshot SEKALI di awal putaran dan hasilnya
 * di-pass ke semua shift. Tidak re-fetch di tiap shift — ini mencegah
 * kondisi race di mana akun N2 sudah "ready" saat shift=1 tapi
 * getReadyAccounts() di shift=2 mengembalikan array berbeda.
 */
async function getReadyAccounts() {
  const dbConnected = await getConnectedAccounts()
  return dbConnected.filter(a => isSocketReady(a.phone))
}

// ─── Pre-flight check ─────────────────────────────────────────────

/**
 * Periksa apakah setiap pasangan yang akan dikirim punya template pesan.
 * Log warning untuk pasangan yang hanya punya fallback — bukan error,
 * hanya informatif agar admin tahu perlu set_msg lebih lengkap.
 */
async function checkTemplateSymmetry(accounts) {
  const N = accounts.length
  const missing = []

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue
      const from = accounts[i].phone
      const to   = accounts[j].phone
      // getMessage() sendiri sudah punya fallback, jadi ini hanya untuk log
      const msg  = await getMessage(from, to)
      const isFallback = msg.startsWith('Hei,') || msg.startsWith('Hai') || msg.startsWith('Halo')
      if (isFallback) missing.push(`${from}→${to}`)
    }
  }

  if (missing.length > 0) {
    console.log(
      `[LOOP] ⚠️  ${missing.length} pasangan pakai fallback dinamis ` +
      `(belum ada template spesifik). Gunakan /set_msg atau /load_script.`
    )
  }

  return missing.length
}

// ─── CORE: Shift Rotation ─────────────────────────────────────────

async function runShiftRotationRound() {
  // FIX v4: Snapshot accounts SEKALI di awal putaran
  const accounts = await getReadyAccounts()
  const N = accounts.length

  if (N < 2) {
    const dbAccounts = await getConnectedAccounts()
    const notReadyCount = dbAccounts.length - N
    console.log(
      `[LOOP] ⚠️  Akun ready: ${N} / DB connected: ${dbAccounts.length}. ` +
      `Minimal 2 ready. Round dilewati.`
    )
    if (notReadyCount > 0) {
      console.log(
        `[LOOP] ${notReadyCount} akun di DB tapi socket belum open. ` +
        `Tunggu koneksi WA stabil...`
      )
    }
    return { roundSent: 0, roundFailed: 0, roundNumber: totalRounds + 1, accountCount: N }
  }

  totalRounds++
  const roundNumber = totalRounds
  let roundSent   = 0
  let roundFailed = 0

  console.log(`\n[LOOP] ╔═══════════════════════════════════════════╗`)
  console.log(`[LOOP] ║  Putaran #${String(roundNumber).padEnd(3)} │ ${N} akun │ ${N * (N - 1)} pesan  ║`)
  console.log(`[LOOP] ╚═══════════════════════════════════════════╝`)

  // Log daftar akun yang terlibat di putaran ini
  accounts.forEach((a, i) => console.log(`[LOOP]   [${i}] ${a.phone}`))

  // Outer Loop: setiap nilai shift (1 … N-1)
  for (let shift = 1; shift < N; shift++) {
    if (!isEngineRunning) {
      console.log('[LOOP] Stop signal — keluar dari outer loop.')
      break
    }

    console.log(`\n[LOOP] ┌─ Shift ${shift}/${N - 1} ${'─'.repeat(36)}`)

    let shiftSent   = 0
    let shiftFailed = 0

    // Track akun yang gagal kirim di shift ini.
    // Jika accounts[i] gagal (offline/socket drop), maka accounts[targetIdx]
    // yang seharusnya "menjawab" juga di-skip — karena lawan bicaranya
    // tidak pernah mengirim, jadi tidak ada yang perlu dibalas.
    // Tanpa ini: A offline → A tidak kirim ke B, tapi B tetap kirim ke A
    // → pesan B menumpuk di A tanpa ada pesan A sebelumnya.
    const failedInShift = new Set() // phone yang gagal kirim di shift ini

    // Inner Loop: setiap pengirim i (0 … N-1)
    for (let i = 0; i < N; i++) {
      if (!isEngineRunning) {
        console.log('[LOOP] Stop signal — keluar dari inner loop.')
        break
      }

      const sender    = accounts[i]
      const targetIdx = (i + shift) % N
      const recipient = accounts[targetIdx]

      if (sender.phone === recipient.phone) continue

      // ── GUARD SIMETRI BILATERAL: cek KEDUA SISI sebelum kirim ───
      //
      // Root cause "No2 tidak balas":
      //   T=0: snapshot [A,B] keduanya ready
      //   T=1: A→B kirim ✅
      //   T=2: micro delay berlangsung (12-35 detik)
      //   T=3: B disconnect DI TENGAH micro delay
      //   T=4: giliran B→A: isSocketReady(B)=false → B di-skip
      //   HASIL: A sudah kirim ke B, tapi B tidak pernah balas → menumpuk
      //
      // Solusi: SEBELUM A kirim ke B, pastikan B juga ready.
      // Jika B tidak ready → batalkan A juga. Tidak ada yang kirim.
      // Tidak ada kiriman sepihak → tidak ada penumpukan.
      const senderReady    = isSocketReady(sender.phone)
      const recipientReady = isSocketReady(recipient.phone)

      if (!senderReady || !recipientReady) {
        const why = !senderReady
          ? `pengirim ${sender.phone} tidak ready`
          : `penerima ${recipient.phone} tidak ready`
        console.log(
          `[LOOP] │  ⏭  Skip bilateral [${why}]: ` +
          `batalkan pasangan ${sender.phone} ↔ ${recipient.phone}`
        )
        // Tandai KEDUANYA agar pasangan balik di iterasi berikutnya juga di-skip
        failedInShift.add(sender.phone)
        failedInShift.add(recipient.phone)
        shiftFailed++
        roundFailed++
        totalFailed++
        if (isEngineRunning && i < N - 1) {
          const microMs = randomDelay(MICRO_MIN(), MICRO_MAX())
          console.log(`[LOOP] │  ⏳ Micro delay ${(microMs / 1000).toFixed(1)}s (bilateral skip)...`)
          await sleep(microMs)
        }
        continue
      }

      // Cek failedInShift — salah satu pihak gagal di iterasi sebelumnya
      if (failedInShift.has(sender.phone) || failedInShift.has(recipient.phone)) {
        console.log(
          `[LOOP] │  ⏭  Skip: salah satu pihak sudah gagal di shift ini ` +
          `(${sender.phone} → ${recipient.phone})`
        )
        shiftFailed++
        roundFailed++
        totalFailed++
        if (isEngineRunning && i < N - 1) {
          const microMs = randomDelay(MICRO_MIN(), MICRO_MAX())
          console.log(`[LOOP] │  ⏳ Micro delay ${(microMs / 1000).toFixed(1)}s (failed skip)...`)
          await sleep(microMs)
        }
        continue
      }

      const message = await getMessage(sender.phone, recipient.phone)
      const success = await sendMessage(sender.phone, recipient.phone, message)

      if (success) {
        shiftSent++
        roundSent++
        totalSent++
        console.log(
          `[LOOP] │  ✅ [shift=${shift} i=${i}→${targetIdx}] ` +
          `${sender.phone} → ${recipient.phone}`
        )
      } else {
        shiftFailed++
        roundFailed++
        totalFailed++
        failedInShift.add(sender.phone) // tandai agar lawan bicara juga di-skip
        console.log(
          `[LOOP] │  ❌ [shift=${shift} i=${i}→${targetIdx}] ` +
          `${sender.phone} → ${recipient.phone}`
        )
      }

      // MICRO DELAY — skip setelah pesan terakhir di shift
      const isLastInShift = i === N - 1
      if (isEngineRunning && !isLastInShift) {
        const base    = randomDelay(MICRO_MIN(), MICRO_MAX())
        const jitter  = Math.floor(base * 0.2 * (Math.random() - 0.5))
        const microMs = Math.max(5000, base + jitter)
        console.log(`[LOOP] │  ⏳ Micro delay ${(microMs / 1000).toFixed(1)}s...`)
        await sleep(microMs)
      }
    } // end inner loop

    console.log(
      `[LOOP] └─ Shift ${shift} selesai │ ` +
      `✅ ${shiftSent} │ ❌ ${shiftFailed}`
    )

    // MACRO DELAY — antar setiap shift (skip setelah shift terakhir)
    if (isEngineRunning && shift < N - 1) {
      const macroMs = randomDelay(MACRO_MIN(), MACRO_MAX())
      console.log(
        `[LOOP] ⏸  Macro delay ${(macroMs / 1000).toFixed(0)}s ` +
        `sebelum shift ${shift + 1}/${N - 1}...`
      )
      await notify(
        `⏸ <b>Shift ${shift}/${N - 1} selesai</b>\n` +
        `✅ Terkirim: <b>${shiftSent}</b> | ❌ Gagal: <b>${shiftFailed}</b>\n` +
        `⏳ Istirahat <b>${(macroMs / 1000).toFixed(0)}s</b>...`
      )
      await sleep(macroMs)
    }
  } // end outer loop

  // Simpan progress ke DB
  const settings = await getSettings()
  await updateSettings({
    loopCount  : (settings.loopCount || 0) + 1,
    lastRun    : new Date().toISOString(),
    totalSent,
    totalFailed
  })

  console.log(
    `\n[LOOP] ✔ Putaran #${roundNumber} selesai │ ` +
    `✅ ${roundSent} │ ❌ ${roundFailed} │ ` +
    `Akumulasi: ${totalSent} terkirim`
  )

  return { roundSent, roundFailed, roundNumber, accountCount: N }
}

// ─── Public API ───────────────────────────────────────────────────

export async function startLoop(chatId, bot) {
  if (isEngineRunning) {
    return { success: false, message: 'Loop sudah berjalan.' }
  }

  const accounts  = await getReadyAccounts()
  const dbAccounts = await getConnectedAccounts()
  const N = accounts.length

  if (N < 2) {
    const tip = dbAccounts.length >= 2
      ? `\n\n⚠️ <b>${dbAccounts.length} akun</b> terdaftar tapi socket belum ready.\nTunggu beberapa detik lalu coba /run lagi.`
      : `\n\nGunakan /add_acc untuk menambahkan akun.`
    return {
      success: false,
      message:
        `Minimal 2 akun harus ready. ` +
        `Saat ini: ${N} ready dari ${dbAccounts.length} connected.${tip}`
    }
  }

  isEngineRunning = true
  adminChatId     = chatId
  telegramBot     = bot
  totalRounds     = 0
  totalSent       = 0
  totalFailed     = 0

  await updateSettings({ isRunning: true })

  // FIX v4: Jalankan pre-flight check template symmetry
  const missingTemplates = await checkTemplateSymmetry(accounts)

  const perRound = N * (N - 1)
  console.log(`[LOOP] ✅ Shift Rotation dimulai! N=${N}, ${perRound} pesan/putaran`)

  const warnText = missingTemplates > 0
    ? `\n⚠️ <b>${missingTemplates} pasangan</b> belum punya template.\nGunakan /set_msg agar pesan lebih natural.`
    : `\n✅ Semua pasangan punya template.`

  await notify(
    `🚀 <b>WA Sender Aktif — Shift Rotation v4</b>\n\n` +
    `📱 Akun ready   : <b>${N}</b>\n` +
    `📨 Pesan/putaran: <b>${perRound}</b>\n` +
    `⏱ Micro delay  : <b>${MICRO_MIN() / 1000}–${MICRO_MAX() / 1000}s</b>\n` +
    `⏸ Macro delay  : <b>${MACRO_MIN() / 1000}–${MACRO_MAX() / 1000}s</b>` +
    warnText +
    `\n\n<i>Gunakan /stop untuk menghentikan.</i>`
  )

  const runLoop = async () => {
    if (!isEngineRunning) return

    try {
      const result = await runShiftRotationRound()

      if (isEngineRunning) {
        const fresh = await getReadyAccounts()
        await notify(
          `📊 <b>Putaran #${result.roundNumber} Selesai</b>\n` +
          `🎭 Akun: <b>${result.accountCount}</b> | ` +
          `✅ <b>${result.roundSent}</b> | ` +
          `❌ <b>${result.roundFailed}</b>\n` +
          `📈 Akumulasi: <b>${totalSent}</b> terkirim\n` +
          `🔄 Akun aktif: <b>${fresh.length}</b>\n\n` +
          `<i>Putaran #${result.roundNumber + 1} dimulai...</i>`
        )
      }
    } catch (err) {
      console.error('[LOOP] Error tidak terduga:', err.message)
      await notify(`⚠️ Error loop: <code>${err.message}</code>`)
    }

    if (isEngineRunning) {
      loopTimer = setTimeout(runLoop, 3_000)
    }
  }

  runLoop()
  return {
    success: true,
    message: `Loop dimulai. Shift Rotation ${N} akun, ${perRound} pesan/putaran.`
  }
}

export async function stopLoop() {
  if (!isEngineRunning) {
    return { success: false, message: 'Loop tidak berjalan.' }
  }

  isEngineRunning = false
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null }

  await updateSettings({ isRunning: false })
  console.log('[LOOP] ⛔ Loop dihentikan.')
  await notify(
    `⛔ <b>WA Sender Dihentikan</b>\n\n` +
    `📊 Statistik sesi ini:\n` +
    `  Putaran selesai : <b>${totalRounds}</b>\n` +
    `  Total terkirim  : <b>${totalSent}</b>\n` +
    `  Total gagal     : <b>${totalFailed}</b>`
  )

  return { success: true, message: 'Loop berhasil dihentikan.' }
}

export function isLoopRunning() { return isEngineRunning }

export async function getLoopStats() {
  const settings   = await getSettings()
  const dbAccounts = await getConnectedAccounts()
  const ready      = await getReadyAccounts()
  return {
    isRunning        : isEngineRunning,
    totalRounds,
    totalSent,
    totalFailed,
    loopCount        : settings.loopCount || 0,
    lastRun          : settings.lastRun,
    connectedAccounts: dbAccounts.length,
    readyAccounts    : ready.length
  }
}
