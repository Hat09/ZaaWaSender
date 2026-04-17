// db/database.js
// Database handler menggunakan Lowdb (JSON-based, ringan & persistent)
//
// FIX v4:
//   getMessage() sekarang mendukung:
//     1. Template spesifik  : fromPhone:toPhone
//     2. Template default   : fromPhone:default
//     3. Template balik     : toPhone:fromPhone  ← BARU (pakai pesan lawan bicara)
//     4. Variasi otomatis   : rotasi dari pool variasi jika tersedia ← BARU
//     5. Fallback dinamis   : pesan berbeda tiap call ← BARU

import { JSONFilePreset } from 'lowdb/node'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'db', 'data.json')

const defaultData = {
  accounts : [],
  messages : [],
  settings : {
    isRunning : false,
    loopCount : 0,
    lastRun   : null
  }
}

// ─── In-memory variant rotation counter ──────────────────────────
//
// Menyimpan posisi rotasi per key ("fromPhone:toPhone") di RAM.
// Tidak perlu persist ke disk — jika bot restart, rotasi mulai
// dari index 0 lagi (tidak masalah, masih natural).
//
// Ini menggantikan variantIndex yang sebelumnya di-write ke DB
// dengan db.write().catch(() => {}) — fire-and-forget yang
// rentan race condition jika dipanggil cepat berturutan.
const variantCounters = new Map() // key → currentIndex

let db = null

export async function initDB() {
  db = await JSONFilePreset(DB_PATH, defaultData)
  await db.read()
  console.log('[DB] Database initialized ✓')
  return db
}

export function getDB() {
  if (!db) throw new Error('Database belum diinisialisasi.')
  return db
}

// ─── Account Operations ───────────────────────────────────────────

export async function upsertAccount(phone, data = {}) {
  await db.read()
  const existing = db.data.accounts.find(a => a.phone === phone)
  if (existing) {
    Object.assign(existing, { ...data, updatedAt: new Date().toISOString() })
  } else {
    db.data.accounts.push({
      phone,
      status   : 'pending',
      addedAt  : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data
    })
  }
  await db.write()
}

export async function updateAccountStatus(phone, status) {
  await db.read()
  const acc = db.data.accounts.find(a => a.phone === phone)
  if (acc) {
    acc.status    = status
    acc.updatedAt = new Date().toISOString()
    await db.write()
  }
}

export async function removeAccount(phone) {
  await db.read()
  db.data.accounts = db.data.accounts.filter(a => a.phone !== phone)
  await db.write()
}

export async function getAllAccounts() {
  await db.read()
  return db.data.accounts
}

export async function getConnectedAccounts() {
  await db.read()
  return db.data.accounts.filter(a => a.status === 'connected')
}

// ─── Message Template Operations ─────────────────────────────────

export async function setMessage(fromPhone, toPhone, message) {
  await db.read()
  const key      = `${fromPhone}:${toPhone}`
  const existing = db.data.messages.find(m => m.key === key)
  if (existing) {
    existing.message   = message
    existing.updatedAt = new Date().toISOString()
    // Reset counter variasi saat pesan diganti
    existing.variantIndex = 0
  } else {
    db.data.messages.push({
      key,
      fromPhone,
      toPhone,
      message,
      variantIndex: 0,   // pointer rotasi variasi
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString()
    })
  }
  await db.write()
}

/**
 * Simpan beberapa variasi pesan untuk satu pasangan.
 * Variasi dirotasi otomatis oleh getMessage().
 * @param {string} fromPhone
 * @param {string} toPhone
 * @param {string[]} variants - array pesan
 */
export async function setMessageVariants(fromPhone, toPhone, variants) {
  if (!variants || variants.length === 0) return
  // Simpan pesan pertama sebagai pesan utama, sisanya sebagai variants
  await db.read()
  const key      = `${fromPhone}:${toPhone}`
  const existing = db.data.messages.find(m => m.key === key)
  if (existing) {
    existing.message      = variants[0]
    existing.variants     = variants
    existing.variantIndex = 0
    existing.updatedAt    = new Date().toISOString()
  } else {
    db.data.messages.push({
      key,
      fromPhone,
      toPhone,
      message     : variants[0],
      variants,
      variantIndex: 0,
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString()
    })
  }
  await db.write()
}

/**
 * Ambil pesan untuk pasangan tertentu.
 *
 * Ambil pesan untuk pasangan tertentu.
 *
 * Urutan prioritas:
 *   1. Template spesifik (fromPhone:toPhone) — rotasi variant in-memory
 *   2. Template default pengirim (fromPhone:default) — rotasi variant
 *   3. Fallback dinamis — pool kalimat berbeda-beda
 *
 * CATATAN: Prioritas "reverse" (toPhone:fromPhone) DIHAPUS.
 * Jika A tidak punya template ke C, memakai template C:A menyebabkan
 * A mengirim kalimat milik C ke C — percakapan terlihat tidak natural.
 * Fallback dinamis lebih aman.
 */
export async function getMessage(fromPhone, toPhone) {
  await db.read()

  // ── Prioritas 1: Template spesifik ────────────────────────────
  const specific = db.data.messages.find(m => m.key === `${fromPhone}:${toPhone}`)
  if (specific) {
    return pickVariant(specific, `${fromPhone}:${toPhone}`)
  }

  // ── Prioritas 2: Template default pengirim ─────────────────────
  const defaultMsg = db.data.messages.find(m => m.key === `${fromPhone}:default`)
  if (defaultMsg) {
    return pickVariant(defaultMsg, `${fromPhone}:default`)
  }

  // ── Prioritas 3: Fallback dinamis ──────────────────────────────
  return getDynamicFallback(fromPhone)
}

/**
 * Ambil variant berikutnya menggunakan in-memory counter (variantCounters Map).
 * Tidak ada disk write → tidak ada race condition, tidak ada data loss saat restart.
 * Restart bot hanya menyebabkan rotasi mulai dari index 0 — itu acceptable.
 *
 * @param {object} record  - entry dari db.data.messages
 * @param {string} key     - "fromPhone:toPhone" sebagai counter key
 * @returns {string}       - teks pesan
 */
function pickVariant(record, key) {
  if (!record.variants || record.variants.length <= 1) {
    return record.message
  }

  const total = record.variants.length
  const idx   = (variantCounters.get(key) || 0) % total
  const text  = record.variants[idx]

  // Advance counter in-memory saja — zero overhead, zero race condition
  variantCounters.set(key, idx + 1)

  return text
}

/**
 * Fallback dinamis: rotasi dari pool kalimat netral.
 * Menggunakan detik saat ini sebagai seed agar berbeda tiap panggilan.
 */
const FALLBACK_POOL = [
  'Hei, apa kabar?',
  'Hai! Lagi sibuk?',
  'Halo, semoga harimu menyenangkan 😊',
  'Hei! Ada kabar baru?',
  'Hai, lagi ngapain? 😄',
  'Halo! Sudah makan belum?',
  'Hei, salam dari sini 👋',
  'Hai! Baik-baik aja kan?',
  'Halo, ketuk ketuk 😄',
  'Hei! Lagi santai?',
]

function getDynamicFallback(fromPhone) {
  // Seed dari kombinasi phone + waktu (detik) agar berbeda antar iterasi
  const seed = (parseInt(fromPhone.slice(-4)) + Math.floor(Date.now() / 1000)) % FALLBACK_POOL.length
  return FALLBACK_POOL[seed]
}

export async function getMessagesByAccount(phone) {
  await db.read()
  return db.data.messages.filter(m => m.fromPhone === phone)
}

// ─── Settings Operations ──────────────────────────────────────────

export async function updateSettings(data) {
  await db.read()
  Object.assign(db.data.settings, data)
  await db.write()
}

export async function getSettings() {
  await db.read()
  return db.data.settings
}
