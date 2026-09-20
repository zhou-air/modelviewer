/** 导航速度设置 —— 原插件 `Settings/NavigationSettingsData.cs` + `NavigationSettingsStore.cs` 的 Web 端对应物。
 *
 * 角色对应：
 *   %APPDATA%\NavisGameNavigation\settings.json   →   localStorage['navisgame.navigationSettings']
 *   字段名与 schemaVersion 保持一致，便于两边互相对照（不是新设计的一套配置）。
 *
 * 数值全部来自原插件 `Core/NavigationDefaults.cs`，一个都没有改。
 *
 * 单位：本项目 GLB 的世界单位就是**米**（证据：converter/rvm_to_glb.py 无缩放参数、
 * reports/phase2-report.md 实测 GLB 尺寸 (199.20, 25.60, 133.36) = (E, U, N) 与 RVM 米制跨度一致）。
 * 因此 5 m/s 在世界坐标里就是 5 单位/秒，换算系数 = 1，手势不需要因单位而调整。
 */

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'navisgame.navigationSettings';

/** 原插件 `Core/NavigationDefaults.cs` 的逐个端口 */
export const NavigationDefaults = Object.freeze({
  NormalSpeedMetersPerSecond: 5.0,
  SprintMultiplier: 3.0,
  MouseSensitivityDegreesPerPixel: 0.12,
  DoubleTapThresholdMilliseconds: 300,
  TimerIntervalMilliseconds: 16,
  MaximumDeltaSeconds: 0.05,
  MinimumFieldOfViewDegrees: 10.0,
  MaximumFieldOfViewDegrees: 100.0,
  MaxPitchDegrees: 89.0,
  Epsilon: 1e-10,
  // 设置校验范围（NavigationSettingsData.ValidateOrDefault）
  NormalSpeedMinimum: 0.1,
  NormalSpeedMaximum: 500.0,
  SprintMultiplierMinimum: 1.0,
  SprintMultiplierMaximum: 10.0,
});

export const MouseSensitivityRadiansPerPixel =
  NavigationDefaults.MouseSensitivityDegreesPerPixel * Math.PI / 180.0;

export const MaxPitchRadians = NavigationDefaults.MaxPitchDegrees * Math.PI / 180.0;

/** 1 米 = 多少世界单位。见文件头注释：本模型为 1。 */
export const WORLD_UNITS_PER_METER = 1.0;

export function createDefaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    normalSpeedMetersPerSecond: NavigationDefaults.NormalSpeedMetersPerSecond,
    sprintMultiplier: NavigationDefaults.SprintMultiplier,
  };
}

/** 1:1 端口 `NavigationSettingsData.ValidateOrDefault`：非法即整体回落到默认值。 */
export function validateOrDefault(value) {
  const ok = value
    && value.schemaVersion === SCHEMA_VERSION
    && Number.isFinite(value.normalSpeedMetersPerSecond)
    && value.normalSpeedMetersPerSecond >= NavigationDefaults.NormalSpeedMinimum
    && value.normalSpeedMetersPerSecond <= NavigationDefaults.NormalSpeedMaximum
    && Number.isFinite(value.sprintMultiplier)
    && value.sprintMultiplier >= NavigationDefaults.SprintMultiplierMinimum
    && value.sprintMultiplier <= NavigationDefaults.SprintMultiplierMaximum;
  return ok ? {
    schemaVersion: value.schemaVersion,
    normalSpeedMetersPerSecond: value.normalSpeedMetersPerSecond,
    sprintMultiplier: value.sprintMultiplier,
  } : createDefaultSettings();
}

function safeStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 对应 `NavigationSettingsStore`：读一次、写时校验、对外只暴露 current。 */
export class NavigationSettingsStore {
  constructor(storage) {
    this.storage = safeStorage(storage);
    this.current = this.load();
  }

  load() {
    try {
      const raw = this.storage ? this.storage.getItem(STORAGE_KEY) : null;
      if (!raw) return createDefaultSettings();
      return validateOrDefault(JSON.parse(raw));
    } catch {
      return createDefaultSettings();   // 解析失败等同"文件不存在"
    }
  }

  save(value) {
    const validated = validateOrDefault(value);
    this.current = validated;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(validated));
    } catch {
      // 隐私模式下写不进去：内存里仍生效，不影响导航
    }
    return validated;
  }

  reset() {
    return this.save(createDefaultSettings());
  }

  /** 每帧都要读，原插件同样是 `_settingsStore.Current.NormalSpeedMetersPerSecond` */
  get normalSpeedMetersPerSecond() { return this.current.normalSpeedMetersPerSecond; }
  get sprintMultiplier() { return this.current.sprintMultiplier; }
}
