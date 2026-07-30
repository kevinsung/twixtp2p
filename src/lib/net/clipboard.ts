/**
 * Copying to the clipboard, including where the modern API is unavailable.
 *
 * `navigator.clipboard` only exists in secure contexts (HTTPS or localhost).
 * Two people testing over a plain-HTTP LAN address are exactly the case this
 * app is built for, and there the room code would otherwise be untouchable —
 * so fall back to the legacy `execCommand` trick through an off-screen
 * textarea.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or a non-secure context; try the legacy path.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
