const STORAGE_KEY = 'pdms-model-viewer-appearance-v1';

export const ENVIRONMENT_MODES = Object.freeze(['solid', 'horizon', 'texture']);

export const ENVIRONMENT_PRESETS = Object.freeze({
  'engineering-light': Object.freeze({
    label: '工程浅灰', skyTopColor: '#dce4ea', skyHorizonColor: '#f4f6f7',
    groundHorizonColor: '#d9dde0', groundFarColor: '#aeb6bd',
  }),
  'blue-sky': Object.freeze({
    label: '蓝天', skyTopColor: '#5f9fd4', skyHorizonColor: '#d9edf8',
    groundHorizonColor: '#cdd5d0', groundFarColor: '#87958b',
  }),
  overcast: Object.freeze({
    label: '阴天', skyTopColor: '#78838c', skyHorizonColor: '#c5cbd0',
    groundHorizonColor: '#aeb4b6', groundFarColor: '#687176',
  }),
  dark: Object.freeze({
    label: '深色', skyTopColor: '#101820', skyHorizonColor: '#35424c',
    groundHorizonColor: '#2b3337', groundFarColor: '#111719',
  }),
});

const DEFAULT_ENVIRONMENT_COLORS = ENVIRONMENT_PRESETS['engineering-light'];

export const APPEARANCE_DEFAULTS = Object.freeze({
  lightingEnabled: true,
  lightingIntensity: 1,
  aoEnabled: false,
  aoIntensity: 0.3,
  aoRadius: 0.12,
  globalModelColor: '#8d949c',
  backgroundColor: '#eef1f3',
  environmentMode: 'solid',
  environmentPreset: 'engineering-light',
  environmentTexture: '',
  environmentColors: Object.freeze({
    skyTopColor: DEFAULT_ENVIRONMENT_COLORS.skyTopColor,
    skyHorizonColor: DEFAULT_ENVIRONMENT_COLORS.skyHorizonColor,
    groundHorizonColor: DEFAULT_ENVIRONMENT_COLORS.groundHorizonColor,
    groundFarColor: DEFAULT_ENVIRONMENT_COLORS.groundFarColor,
  }),
  groundEnabled: false,
  groundColor: '#d7dde3',
});

export function normalizeColor(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : fallback;
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const number = (key, min, max) => typeof source[key] === 'number' && Number.isFinite(source[key])
    ? Math.max(min, Math.min(max, source[key])) : APPEARANCE_DEFAULTS[key];
  const preset = Object.hasOwn(ENVIRONMENT_PRESETS, source.environmentPreset)
    ? source.environmentPreset : (source.environmentPreset === 'custom' ? 'custom' : APPEARANCE_DEFAULTS.environmentPreset);
  const sourceColors = source.environmentColors && typeof source.environmentColors === 'object'
    ? source.environmentColors : {};
  const colorFallback = ENVIRONMENT_PRESETS[preset] || APPEARANCE_DEFAULTS.environmentColors;
  return {
    lightingEnabled: typeof source.lightingEnabled === 'boolean' ? source.lightingEnabled : true,
    lightingIntensity: number('lightingIntensity', 0.2, 2),
    aoEnabled: typeof source.aoEnabled === 'boolean' ? source.aoEnabled : APPEARANCE_DEFAULTS.aoEnabled,
    aoIntensity: number('aoIntensity', 0, 1.5),
    aoRadius: number('aoRadius', 0.02, 0.5),
    globalModelColor: normalizeColor(source.globalModelColor, APPEARANCE_DEFAULTS.globalModelColor),
    backgroundColor: normalizeColor(source.backgroundColor, APPEARANCE_DEFAULTS.backgroundColor),
    environmentMode: ENVIRONMENT_MODES.includes(source.environmentMode)
      ? source.environmentMode : APPEARANCE_DEFAULTS.environmentMode,
    environmentPreset: preset,
    environmentTexture: typeof source.environmentTexture === 'string'
      ? source.environmentTexture.trim().slice(0, 512) : '',
    environmentColors: {
      skyTopColor: normalizeColor(sourceColors.skyTopColor, colorFallback.skyTopColor),
      skyHorizonColor: normalizeColor(sourceColors.skyHorizonColor, colorFallback.skyHorizonColor),
      groundHorizonColor: normalizeColor(sourceColors.groundHorizonColor, colorFallback.groundHorizonColor),
      groundFarColor: normalizeColor(sourceColors.groundFarColor, colorFallback.groundFarColor),
    },
    groundEnabled: source.groundEnabled === true,
    groundColor: normalizeColor(source.groundColor, APPEARANCE_DEFAULTS.groundColor),
  };
}

/** 用户级外观偏好：跨 Project / Model / Version，当前浏览器设备有效。 */
export class AppearanceSettings {
  constructor(storage) {
    if (storage !== undefined) this.storage = storage;
    else {
      try { this.storage = globalThis.localStorage; } catch (e) { this.storage = null; }
    }
    this.values = this._read();
  }

  _read() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.aoRadius === undefined && saved.aoIntensity === 0.65) saved.aoIntensity = 0.3;
      return normalizeSettings(saved);
    } catch (e) {
      return { ...APPEARANCE_DEFAULTS };
    }
  }

  _write() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch (e) { /* private mode */ }
  }

  get current() { return { ...this.values, environmentColors: { ...this.values.environmentColors } }; }

  patch(changes = {}) {
    const environmentColors = changes.environmentColors
      ? { ...this.values.environmentColors, ...changes.environmentColors }
      : this.values.environmentColors;
    this.values = normalizeSettings({ ...this.values, ...changes, environmentColors });
    this._write();
    return this.current;
  }

  reset() {
    this.values = normalizeSettings(APPEARANCE_DEFAULTS);
    try { this.storage?.removeItem(STORAGE_KEY); } catch (e) { /* private mode */ }
    return this.current;
  }
}
