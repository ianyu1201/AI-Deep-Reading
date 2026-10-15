/** Ordered shutdown boundary; no renderer is closed until draft choice and
 * runtime disposal succeed. Diagnostics never decide whether exit succeeds. */
export async function shutdownApplication({ flushDrafts, confirmExit, stopRuntime, writeDiagnostics, closeViews, finishExit, onBlocked, onDiagnosticError }) {
  const blocked = async stage => {
    try { await onBlocked(stage); } catch { /* Error presentation must not wedge the next close attempt. */ }
    return { closed: false, reason: stage };
  };
  let draftResults;
  try { draftResults = await flushDrafts(); }
  catch { return blocked('drafts'); }
  if (draftResults.some(result => !result?.ok)) {
    try {
      if (!await confirmExit()) return { closed: false, reason: 'draft-review' };
    } catch { return blocked('draft-confirmation'); }
  }
  try { await stopRuntime(); }
  catch { return blocked('runtime-stop'); }
  try { await writeDiagnostics(draftResults); }
  catch {
    try { await onDiagnosticError?.(); } catch { /* Diagnostic failures are non-blocking. */ }
  }
  await closeViews();
  await finishExit();
  return { closed: true };
}
