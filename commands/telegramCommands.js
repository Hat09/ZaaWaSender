// ── LOAD SCRIPT: STEP 2 — Konfirmasi ─────────────────────────────
if (state.step === 'load_script_confirm') {
  const answer = text.toLowerCase()
  if (answer === 'ya' || answer === 'y' || answer === 'yes') {
    await saveScriptToDatabase(ctx, userId)
  } else if (answer === 'tidak' || answer === 'n' || answer === 'no') {
    userStates.delete(userId)
    pendingScripts.delete(userId)
    await ctx.reply('❌ Dibatalkan. Template tidak disimpan.');
  } else {
    // Re-prompt jika input tidak valid
    await ctx.replyWithHTML(
      '⚠️ Input tidak dikenali.\n\n' +
      'Ketik <b>ya</b> untuk menyimpan atau <b>tidak</b> untuk membatalkan.'
    )
  }
  return
}