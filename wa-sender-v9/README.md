# 🤖 WA Sender — WhatsApp Cross-Messaging Bot

Bot Telegram untuk mengatur banyak akun WhatsApp (Multi-Session) agar dapat saling mengirim pesan secara otomatis dan terus-menerus (Cross-Messaging Loop).

---

## 📁 Struktur Folder

```
wa-sender/
├── index.js                    # Entry point utama
├── package.json
├── .env                        # Konfigurasi (buat dari .env.example)
├── .env.example
│
├── db/
│   ├── database.js             # Handler database (Lowdb)
│   └── data.json               # File database (auto-generated)
│
├── handlers/
│   ├── waSession.js            # Manager sesi WhatsApp (Baileys)
│   └── loopEngine.js          # Engine cross-messaging loop
│
├── commands/
│   └── telegramCommands.js    # Handler semua command Telegram
│
└── sessions/                   # Folder sesi WA (auto-generated)
    ├── 628111111111/           # Sesi per nomor
    ├── 628222222222/
    └── ...
```

---

## ⚙️ Instalasi

### 1. Prasyarat
- **Node.js** versi 18 atau lebih baru
- **npm** atau **pnpm**
- Akun Telegram & Bot Token dari [@BotFather](https://t.me/BotFather)

### 2. Clone / Download Project

```bash
# Clone atau copy folder wa-sender ke server/PC kamu
cd wa-sender
```

### 3. Install Dependensi

```bash
npm install
```

### 4. Konfigurasi Environment

```bash
# Copy file contoh
cp .env.example .env

# Edit file .env
nano .env
```

Isi konfigurasi di `.env`:

```env
# Token dari @BotFather
BOT_TOKEN=1234567890:AABBccDDeeFFggHH...

# Telegram User ID kamu (cek di @userinfobot)
ALLOWED_USERS=123456789

# Delay antar pesan (millisecond)
DELAY_MIN=5000
DELAY_MAX=15000

# Interval antar loop penuh (millisecond)
LOOP_INTERVAL=60000
```

### 5. Jalankan Bot

```bash
node index.js
```

Atau untuk development dengan auto-restart:

```bash
node --watch index.js
```

---

## 🎮 Cara Penggunaan

### Langkah 1: Mulai Bot
Buka Telegram, cari bot kamu, ketik `/start`

### Langkah 2: Tambah Akun WhatsApp
```
/add_acc
```
→ Masukkan nomor WA (contoh: `628123456789`)
→ Bot akan memberikan **Pairing Code 8 digit**

**Cara pairing di HP:**
1. Buka WhatsApp → Menu (⋮) → Linked Devices
2. Tap "Link a Device"
3. Pilih **"Link with phone number instead"**
4. Masukkan kode yang diberikan bot

Ulangi untuk semua akun yang ingin didaftarkan.

### Langkah 3: Cek Daftar Akun
```
/list_acc
```
Pastikan semua akun berstatus 🟢 **connected**

### Langkah 4: Set Template Pesan (Opsional)
```
/set_msg
```
→ Pilih nomor pengirim
→ Pilih nomor penerima (atau `default` untuk semua)
→ Ketik isi pesan

### Langkah 5: Mulai Loop
```
/run
```
Bot akan mulai mengirim pesan antar semua akun secara otomatis.

### Langkah 6: Hentikan Loop
```
/stop
```

---

## 📋 Daftar Perintah

| Perintah | Fungsi |
|---|---|
| `/start` | Tampilkan menu utama |
| `/add_acc` | Tambah & pairing akun WA baru |
| `/list_acc` | Lihat daftar akun & statusnya |
| `/remove_acc` | Hapus akun dari sistem |
| `/set_msg` | Atur template pesan per nomor |
| `/run` | Mulai cross-messaging loop |
| `/stop` | Hentikan semua pengiriman |
| `/status` | Lihat statistik & status loop |

---

## 🔄 Logika Cross-Messaging

Jika ada 3 akun (A, B, C):
- A mengirim ke B dan C
- B mengirim ke A dan C
- C mengirim ke A dan B

Jika ada 10 akun, setiap akun mengirim ke 9 akun lainnya = **90 pesan per iterasi**.

---

## 🛡️ Fitur Anti-Banned

- ✅ **Delay acak** antar setiap pesan (default: 5-15 detik)
- ✅ **Pairing Code** (bukan QR Code) — lebih aman
- ✅ **Session persistent** — tidak perlu pairing ulang setelah restart
- ✅ **Auto reconnect** jika koneksi terputus

---

## 🔧 Konfigurasi Lanjutan

Ubah nilai di `.env` untuk menyesuaikan:

```env
# Perlambat pengiriman (lebih aman)
DELAY_MIN=10000   # 10 detik
DELAY_MAX=30000   # 30 detik

# Jarangkan loop
LOOP_INTERVAL=120000  # 2 menit antar loop
```

---

## 🚨 Troubleshooting

**Bot tidak merespons:**
- Pastikan `BOT_TOKEN` benar
- Pastikan `ALLOWED_USERS` berisi Telegram ID kamu

**Pairing code tidak muncul:**
- Pastikan nomor sudah terdaftar di WhatsApp
- Pastikan format nomor benar (628xxxxxxxxx)
- Coba lagi setelah beberapa detik

**Akun disconnect terus:**
- Normal jika HP dimatikan atau tidak ada internet
- Bot akan auto-reconnect otomatis

**Pesan tidak terkirim:**
- Cek status akun dengan `/list_acc`
- Pastikan nomor tujuan valid dan aktif di WA

---

## ⚠️ Disclaimer

Tool ini dibuat untuk keperluan edukasi dan otomasi yang sah. Penggunaan yang melanggar Terms of Service WhatsApp sepenuhnya menjadi tanggung jawab pengguna.
