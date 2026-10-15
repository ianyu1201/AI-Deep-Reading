// Shell dialogs must cover resident native reader views as well as the shell.
export async function showNativeDialog(dialog, focus) {
  await window.readingAppearance.modal(true);
  dialog.addEventListener('close', () => { void window.readingAppearance.modal(false); }, { once: true });
  try { dialog.showModal(); focus?.focus(); }
  catch (error) { await window.readingAppearance.modal(false); throw error; }
}
