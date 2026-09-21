const STORAGE_KEY = 'modelviewer.keyBindings';

export const KEY_BINDING_DEFINITIONS = Object.freeze([
  { id: 'navigation.toggle', group: 'Game Navigation', label: '切换 Game / Orbit', code: 'F8' },
  { id: 'navigation.forward', group: 'Game Navigation', label: '前进', code: 'KeyW' },
  { id: 'navigation.backward', group: 'Game Navigation', label: '后退', code: 'KeyS' },
  { id: 'navigation.left', group: 'Game Navigation', label: '左移', code: 'KeyA' },
  { id: 'navigation.right', group: 'Game Navigation', label: '右移', code: 'KeyD' },
  { id: 'navigation.up', group: 'Game Navigation', label: '上升', code: 'Space' },
  { id: 'navigation.down', group: 'Game Navigation', label: '下降 / 加速修饰键', code: 'ShiftLeft' },
  { id: 'navigation.escape', group: 'Game Navigation', label: '释放鼠标 / 退出操作', code: 'Escape' },
  { id: 'navigation.fit', group: 'Game Navigation', label: '复位到选中部件', code: 'KeyF' },
  { id: 'measurement.center', group: 'Measurement', label: '取对象中心点', code: 'KeyC' },
  { id: 'measurement.continuous', group: 'Measurement', label: '连续测量', code: 'KeyV' },
  { id: 'measurement.undo', group: 'Measurement', label: '撤销上一步', code: 'KeyZ' },
  { id: 'measurement.removeLast', group: 'Measurement', label: '删除上一条', code: 'Delete' },
  { id: 'measurement.escape', group: 'Measurement', label: '取消未完成测量', code: 'Escape' },
]);

const defaults = Object.fromEntries(KEY_BINDING_DEFINITIONS.map((x) => [x.id, x.code]));
const isValid = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(value);

export class KeyBindings {
  constructor() { this.current = this._load(); }
  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const next = { ...defaults };
      for (const id of Object.keys(next)) if (isValid(raw[id])) next[id] = raw[id];
      return next;
    } catch { return { ...defaults }; }
  }
  get(id) { return this.current[id] || defaults[id]; }
  has(id, code) { return this.get(id) === code; }
  set(id, code) {
    if (!defaults[id] || !isValid(code)) return { ok: false, reason: 'invalid' };
    const conflict = Object.entries(this.current).find(([other, value]) => other !== id && value === code);
    if (conflict) return { ok: false, reason: 'conflict', with: conflict[0] };
    this.current[id] = code;
    this._save();
    return { ok: true };
  }
  reset() { this.current = { ...defaults }; this._save(); }
  _save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current)); } catch { /* storage unavailable */ } }
}

export const keyBindings = new KeyBindings();
export const keyBindingDefaults = Object.freeze({ ...defaults });
