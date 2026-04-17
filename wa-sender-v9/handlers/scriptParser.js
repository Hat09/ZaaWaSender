// handlers/scriptParser.js  (v4)
// Parser file Percakapan.txt → distribusi pesan ke akun WA
//
// FIX v4:
//   - buildMessageTemplates() sekarang menghasilkan VARIASI pesan per pasangan
//     (kumpulkan semua baris dialog dari speaker tertentu ke penerima tertentu
//      sebagai array variants, bukan digabung jadi 1 string panjang)
//   - Gunakan setMessageVariants() agar getMessage() bisa rotasi variant
//   - Pastikan arah BALIK juga dapat template (No2→No1 dapat baris dialog No1)

import { readFile } from 'fs/promises'
import { setMessage, setMessageVariants, getAllAccounts } from '../db/database.js'

/**
 * Parse baris-baris percakapan dari string teks.
 * Format: No1: teks, No2: teks, dst.
 */
export function parseScript(content) {
  const lines      = content.split('\n')
  const dialogLines = []

  for (const raw of lines) {
    const line  = raw.trim()
    if (!line) continue
    const match = line.match(/^(No\d+)\s*:\s*(.+)$/i)
    if (match) {
      dialogLines.push({
        speaker: match[1].toLowerCase(),
        text   : match[2].trim()
      })
    }
  }

  return dialogLines
}

export function getUniqueSpeakers(dialogs) {
  const set = new Set(dialogs.map(d => d.speaker))
  return [...set].sort((a, b) => {
    const na = parseInt(a.replace('no', ''))
    const nb = parseInt(b.replace('no', ''))
    return na - nb
  })
}

export function mapSpeakersToAccounts(speakers, phones) {
  const mapping = new Map()
  speakers.forEach((speaker, idx) => {
    mapping.set(speaker, phones[idx % phones.length])
  })
  return mapping
}

/**
 * Bangun template pesan per pasangan.
 *
 * Setiap baris dialog disimpan sebagai elemen terpisah di variants[].
 * getMessage() merotasi variants[] secara round-robin setiap putaran,
 * sehingga tiap putaran akun mengirim baris dialog berikutnya.
 *
 * PENTING: Tidak ada dedup baris identik. Script boleh punya baris
 * yang sama (intentional — penulis sengaja mengulang kalimat).
 * Mendedup akan menyebabkan variants[].length < jumlah baris sebenarnya
 * dan variantIndex 0 % 1 = 0 → pesan yang sama terkirim selamanya.
 *
 * Format output:
 *   { from, to, variants: ['baris1', 'baris2', ...] }
 */
export function buildMessageTemplates(dialogs, speakerMap) {
  const phones     = [...new Set(speakerMap.values())]
  const variantMap = new Map() // "from:to" → string[]

  for (const dialog of dialogs) {
    const fromPhone = speakerMap.get(dialog.speaker)
    if (!fromPhone) continue

    const recipients = phones.filter(p => p !== fromPhone)

    for (const toPhone of recipients) {
      const key = `${fromPhone}:${toPhone}`
      if (!variantMap.has(key)) variantMap.set(key, [])
      // JANGAN dedup — baris sama dalam script adalah intentional
      variantMap.get(key).push(dialog.text)
    }
  }

  const result = []
  for (const [key, variants] of variantMap.entries()) {
    const [from, to] = key.split(':')
    result.push({ from, to, variants })
  }
  return result
}

/**
 * Main: load file → parse → simpan ke DB dengan variants
 */
export async function loadScriptToDatabase(filePath, overridePhones = null) {
  const content = await readFile(filePath, 'utf-8')

  const dialogs = parseScript(content)
  if (dialogs.length === 0) {
    return {
      success: false,
      error  : 'Tidak ada dialog terdeteksi. Format: No1: teks'
    }
  }

  let phones = overridePhones
  if (!phones) {
    const accounts = await getAllAccounts()
    phones = accounts.map(a => a.phone)
  }

  if (phones.length < 2) {
    return { success: false, error: 'Minimal 2 akun diperlukan.' }
  }

  const speakers   = getUniqueSpeakers(dialogs)
  const speakerMap = mapSpeakersToAccounts(speakers, phones)
  const templates  = buildMessageTemplates(dialogs, speakerMap)

  let saved = 0
  for (const t of templates) {
    await setMessageVariants(t.from, t.to, t.variants)
    saved++
  }

  const mappingInfo = []
  for (const [speaker, phone] of speakerMap.entries()) {
    const lineCount = dialogs.filter(d => d.speaker === speaker).length
    mappingInfo.push({ speaker, phone, lineCount })
  }

  return {
    success: true,
    stats  : {
      totalDialogLines: dialogs.length,
      uniqueSpeakers  : speakers.length,
      accountsUsed    : phones.length,
      templatesSaved  : saved,
      mapping         : mappingInfo
    }
  }
}

/**
 * Preview distribusi tanpa menyimpan ke DB
 */
export async function previewScriptDistribution(content, phones) {
  const dialogs = parseScript(content)
  if (dialogs.length === 0) return { error: 'Tidak ada dialog terdeteksi.' }

  const speakers   = getUniqueSpeakers(dialogs)
  const speakerMap = mapSpeakersToAccounts(speakers, phones)
  const templates  = buildMessageTemplates(dialogs, speakerMap)

  const preview = []
  for (const [speaker, phone] of speakerMap.entries()) {
    const lines = dialogs.filter(d => d.speaker === speaker)
    preview.push({
      speaker,
      mappedTo   : phone,
      sampleLines: lines.slice(0, 2).map(l => l.text),
      totalLines : lines.length
    })
  }

  return {
    totalLines: dialogs.length,
    speakers  : speakers.length,
    templates : templates.length,
    preview
  }
}
