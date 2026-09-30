/** 本机剪贴板通道 —— 测量结果导出与批注导出/导入共用，不再各写一份。
 *
 *  上下文：localhost / https 是安全上下文，`navigator.clipboard` 可用；
 *  局域网 http://192.168.x.x 不是，`navigator.clipboard` 为 undefined ——
 *  写走 textarea + execCommand('copy') 回退；读没有回退通道，只能提示用户手动粘贴。
 *  两条路都失败时返回 null，由调用方给出明确提示（不静默失败）。
 */

/** 写入剪贴板。返回 'clipboard' | 'execCommand' | null。 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return 'clipboard';
    }
  } catch { /* 掉到回退通道 */ }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok ? 'execCommand' : null;
}

/** 读取剪贴板文本。安全上下文才可能成功，失败返回 null（由调用方退回手动粘贴）。 */
export async function readText() {
  try {
    if (!navigator.clipboard?.readText) return null;
    const text = await navigator.clipboard.readText();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;   // 含用户拒绝授权 / 非安全上下文
  }
}
