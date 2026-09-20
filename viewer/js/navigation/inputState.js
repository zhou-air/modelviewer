/** 导航输入层：键盘 / 鼠标 / 焦点 / 指针捕获。
 *
 * 内容分三块：
 *   1. `InputState`        —— 原插件 `Core/InputState.cs` 的 1:1 端口（宿主无关的纯状态机）
 *   2. `PointerCapture`    —— 原插件 `Input/MouseCapture.cs` 的 Web 替代（光标锚定 → Pointer Lock）
 *   3. `NavigationInputSource` —— DOM 接线（原插件 `Input/NavigationKeyboardInterceptor.cs`
 *                                 + `GameNavigationController` 的事件部分）
 *
 * 刻意不移植的东西（原插件为 Navisworks 宿主缺陷而写，Web 不存在这些问题）：
 *   · Win32 物理键盘轮询（NativeMethods.IsKeyDown）      → 浏览器 keydown/keyup 更可靠
 *   · 光标锚点回拉（RelativeMouseTracker / SetCursorPos）→ Pointer Lock 的 movementX/Y 天然是无限增量
 *   · IME 解绑（ImmAssociateContext）                    → 浏览器键盘事件不受 Windows IME 影响
 *   · 消息钩子预吞按键（SetWindowsHookEx）               → 浏览器没有宿主加速键
 */

import { NavigationDefaults } from './navigationSettings.js';

/** 原插件 `Core/NavigationKey.cs` */
export const NavigationKey = Object.freeze({
  Forward: 'Forward',
  Backward: 'Backward',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
});

/** 原插件 `GameNavigationController.TryMapKey` 的键位别名表（虚拟键码 → DOM 物理键码）。
 *  用 `e.code`（物理键位）而不是 `e.key`，因为原插件用的是 VK 码，语义就是"物理按键位置"。
 *  方向键作为 WASD 的别名一并保留。 */
const CODE_TO_NAVIGATION_KEY = new Map([
  ['KeyW', NavigationKey.Forward],
  ['ArrowUp', NavigationKey.Forward],
  ['KeyS', NavigationKey.Backward],
  ['ArrowDown', NavigationKey.Backward],
  ['KeyA', NavigationKey.Left],
  ['ArrowLeft', NavigationKey.Left],
  ['KeyD', NavigationKey.Right],
  ['ArrowRight', NavigationKey.Right],
  ['Space', NavigationKey.Up],
  ['ShiftLeft', NavigationKey.Down],
  ['ShiftRight', NavigationKey.Down],
]);

/** 兜底：`e.code` 缺失或异常的浏览器用 `e.key`（只覆盖无歧义的几个） */
const KEY_TO_NAVIGATION_KEY = new Map([
  ['w', NavigationKey.Forward], ['W', NavigationKey.Forward],
  ['s', NavigationKey.Backward], ['S', NavigationKey.Backward],
  ['a', NavigationKey.Left], ['A', NavigationKey.Left],
  ['d', NavigationKey.Right], ['D', NavigationKey.Right],
  [' ', NavigationKey.Up], ['Spacebar', NavigationKey.Up],
  ['Shift', NavigationKey.Down],
]);

export function navigationKeyOf(event) {
  if (event.code && CODE_TO_NAVIGATION_KEY.has(event.code)) {
    return CODE_TO_NAVIGATION_KEY.get(event.code);
  }
  return KEY_TO_NAVIGATION_KEY.get(event.key) || null;
}

/** 原插件 `Core/InputState.cs` —— 逐行端口，行为一字未改。
 *
 *  - 按键用集合去重，因此**自动重复不会刷新双击时间戳**（对应 `TestAutoRepeat`）
 *  - 双击判定窗口 300 ms，仅在按下 Forward 时评估（对应 `TestDoubleTapSprint` / `TestLateSecondTap`）
 *  - 松开 Forward 立即 `isSprinting = false`（对应 `TestReleaseClearsSprint`）
 *  - 轴向量由正负相消得到，范围只有 -1/0/1（对应 `TestOppositeKeysCancel`）
 *  - 鼠标增量累积后**每帧只消费一次**（对应 `TestMouseDeltaConsumption`）
 */
export class InputState {
  constructor() {
    this._pressed = new Set();
    this._lastForwardPressMilliseconds = null;
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
    this.isSprinting = false;
    // 复用对象，避免每帧产生垃圾
    this._axes = { forward: 0, right: 0, up: 0 };
    this._delta = { x: 0, y: 0 };
  }

  keyDown(key, timestampMilliseconds) {
    if (this._pressed.has(key)) return false;
    this._pressed.add(key);
    if (key === NavigationKey.Forward) {
      if (this._lastForwardPressMilliseconds !== null) {
        const elapsed = timestampMilliseconds - this._lastForwardPressMilliseconds;
        this.isSprinting = elapsed >= 0 && elapsed <= NavigationDefaults.DoubleTapThresholdMilliseconds;
      }
      this._lastForwardPressMilliseconds = timestampMilliseconds;
    }
    return true;
  }

  keyUp(key) {
    const removed = this._pressed.delete(key);
    if (key === NavigationKey.Forward) this.isSprinting = false;
    return removed;
  }

  isPressed(key) { return this._pressed.has(key); }

  addMouseDelta(deltaX, deltaY) {
    this._mouseDeltaX += deltaX;
    this._mouseDeltaY += deltaY;
  }

  /** 对应 `ConsumeMouseDelta(out x, out y)` */
  consumeMouseDelta() {
    this._delta.x = this._mouseDeltaX;
    this._delta.y = this._mouseDeltaY;
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
    return this._delta;
  }

  /** 对应 `GetAxes(out forward, out right, out up)` */
  getAxes() {
    this._axes.forward = this._axis(NavigationKey.Forward, NavigationKey.Backward);
    this._axes.right = this._axis(NavigationKey.Right, NavigationKey.Left);
    this._axes.up = this._axis(NavigationKey.Up, NavigationKey.Down);
    return this._axes;
  }

  reset() {
    this._pressed.clear();
    this._lastForwardPressMilliseconds = null;
    this.isSprinting = false;
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
  }

  _axis(positive, negative) {
    return (this._pressed.has(positive) ? 1 : 0) - (this._pressed.has(negative) ? 1 : 0);
  }

  /** 供自动化实测读取（原插件的 RuntimeTrace 同角色） */
  snapshot() {
    const a = this.getAxes();
    return {
      pressed: [...this._pressed],
      forward: a.forward, right: a.right, up: a.up,
      sprinting: this.isSprinting,
    };
  }
}

/** 原插件 `Input/MouseCapture.cs` 的 Web 替代。
 *
 * 替换关系：
 *   CaptureAt(view) + GetCursorPos/SetCursorPos 锚点回拉  →  requestPointerLock()
 *   每帧读光标求差                                      →  mousemove 的 movementX / movementY
 *
 * 语义保持：必须由用户在三维视图内的**一次点击**触发捕获；未捕获时鼠标不控制相机。
 * 刻意不传 `unadjustedMovement: true`：原插件的增量来自 `GetCursorPos()`，是经过操作系统
 * 指针加速的位移；浏览器默认的 `movementX` 同样经过加速。要保留原手感，就保持默认。
 */
export class PointerCapture {
  constructor(canvas) {
    this.canvas = canvas;
    this._intentionalExit = false;
    this.lastError = null;
  }

  get isCaptured() {
    return !!document.pointerLockElement && document.pointerLockElement === this.canvas;
  }

  /** 必须在用户手势（点击 canvas）里调用 */
  request() {
    if (this.isCaptured) return Promise.resolve(true);
    this._intentionalExit = false;
    try {
      const result = this.canvas.requestPointerLock();
      if (result && typeof result.then === 'function') {
        return result.then(() => true).catch((e) => {
          // Chrome 在按下 Esc 后约 1.25 秒内会拒绝重新加锁，这里如实上报以便提示用户重试
          this.lastError = String((e && e.message) || e);
          return false;
        });
      }
      return Promise.resolve(true);
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      return Promise.resolve(false);
    }
  }

  release() {
    if (!this.isCaptured) return;
    this._intentionalExit = true;
    try { document.exitPointerLock(); } catch { /* 忽略：文档可能正在卸载 */ }
  }

  /** 消费"这次解锁是我自己发起的"标记，用于区分用户按 Esc（退出导航）与失焦（暂停） */
  consumeIntentionalExit() {
    const value = this._intentionalExit;
    this._intentionalExit = false;
    return value;
  }
}

/** DOM 接线层。
 *
 * §11 要求"反复 Orbit ⇄ Game 切换不得叠加监听"：所有监听器在 `attach()` 里**只注册一次**，
 * 模式切换只改状态位（由 EngineeringNavigation 负责），不存在增删监听的时机问题。
 */
export class NavigationInputSource {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.input = new InputState();
    this.capture = new PointerCapture(canvas);
    this._options = options;
    this._attached = false;
    this._hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    this._bound = {};
  }

  get hasFocus() { return this._hasFocus; }
  get isCaptured() { return this.capture.isCaptured; }
  get isAttached() { return this._attached; }

  /** 导航模式是否开启（由 EngineeringNavigation 注入的 getter） */
  _isActive() { return !!(this._options.isActive && this._options.isActive()); }

  /** 导航是否处于暂停（失焦） */
  _isPaused() { return !!(this._options.isPaused && this._options.isPaused()); }

  attach() {
    if (this._attached) return;
    const b = this._bound;
    b.keydown = (e) => this._onKeyDown(e);
    b.keyup = (e) => this._onKeyUp(e);
    b.mousemove = (e) => this._onMouseMove(e);
    b.wheel = (e) => this._onWheel(e);
    b.pointerdown = (e) => this._onPointerDown(e);
    b.contextmenu = (e) => this._onContextMenu(e);
    b.blur = () => this._onBlur();
    b.focus = () => this._onFocus();
    b.visibilitychange = () => { if (document.hidden) this._onBlur(); else this._onFocus(); };
    b.pointerlockchange = () => this._onPointerLockChange();
    b.pointerlockerror = () => { this.capture.lastError = 'pointerlockerror'; this._options.onCaptureChanged?.(); };

    window.addEventListener('keydown', b.keydown);
    window.addEventListener('keyup', b.keyup);
    document.addEventListener('mousemove', b.mousemove);
    this.canvas.addEventListener('wheel', b.wheel, { passive: false });
    this.canvas.addEventListener('pointerdown', b.pointerdown);
    this.canvas.addEventListener('contextmenu', b.contextmenu);
    window.addEventListener('blur', b.blur);
    window.addEventListener('focus', b.focus);
    document.addEventListener('visibilitychange', b.visibilitychange);
    document.addEventListener('pointerlockchange', b.pointerlockchange);
    document.addEventListener('pointerlockerror', b.pointerlockerror);
    this._attached = true;
  }

  detach() {
    if (!this._attached) return;
    const b = this._bound;
    window.removeEventListener('keydown', b.keydown);
    window.removeEventListener('keyup', b.keyup);
    document.removeEventListener('mousemove', b.mousemove);
    this.canvas.removeEventListener('wheel', b.wheel);
    this.canvas.removeEventListener('pointerdown', b.pointerdown);
    this.canvas.removeEventListener('contextmenu', b.contextmenu);
    window.removeEventListener('blur', b.blur);
    window.removeEventListener('focus', b.focus);
    document.removeEventListener('visibilitychange', b.visibilitychange);
    document.removeEventListener('pointerlockchange', b.pointerlockchange);
    document.removeEventListener('pointerlockerror', b.pointerlockerror);
    this._attached = false;
  }

  reset() { this.input.reset(); }

  /** 用户手势里请求捕获（点击 canvas） */
  requestCapture() { return this.capture.request(); }
  releaseCapture() { this.capture.release(); }

  // ------------------------------------------------------------------ 事件
  _onKeyDown(e) {
    // 设置面板的数字框里打字时不驱动相机（Web 才有的输入框，原插件无此情形）
    if (isEditableTarget(e.target)) return;

    if (e.key === 'F8') {
      e.preventDefault();
      this._options.onToggleNavigation?.();
      return;
    }

    if (e.key === 'Escape') {
      // 指针锁定时浏览器会自己吞掉 Esc（只解除锁定，不给 keydown），
      // 那条路径由 pointerlockchange 处理；这里覆盖"未锁定但导航开着"的情况。
      if (this._isActive()) {
        e.preventDefault();
        this._options.onEscape?.();
      }
      return;
    }

    const key = navigationKeyOf(e);
    if (!key) return;

    // 与原件一致：只有"导航开启且已捕获"时才消费导航输入。
    // 未捕获时不得记录按键——否则捕获前按下的 W/Shift（如 Shift+点击树）会在
    // 捕获瞬间一起生效，表现为"自动移动"。
    if (this._isActive() && this.isCaptured) {
      e.preventDefault();
      this.input.keyDown(key, Math.round(performance.now()));
    }
  }

  _onKeyUp(e) {
    if (isEditableTarget(e.target)) return;
    const key = navigationKeyOf(e);
    if (!key) return;
    // 松开永远处理，避免残留按键（原件对 modifier 自愈的处理目的相同）
    if (this._isActive()) this.input.keyUp(key);
  }

  _onMouseMove(e) {
    // 对应 MouseCapture.TryGetDelta：未捕获时不产生任何视角增量
    if (!this._isActive() || !this.isCaptured) return;
    // 钳制单事件增量：Pointer Lock 刚建立的首个 mousemove 可能带出巨大的伪
    // movementX/Y（浏览器伪增量，可达数千），不钳就表现为视角"瞬移"。
    // 真实快速甩动的单事件增量远小于该值，不受影响。
    const CLAMP = 250;
    const dx = Math.max(-CLAMP, Math.min(CLAMP, e.movementX || 0));
    const dy = Math.max(-CLAMP, Math.min(CLAMP, e.movementY || 0));
    if (dx !== 0 || dy !== 0) this.input.addMouseDelta(dx, dy);
  }

  _onWheel(e) {
    // Orbit 模式下完全放行给 OrbitControls（controls.enabled=false 时它会自行忽略）
    // 暂停中也不接收（原插件 Wheel() 的条件就是 IsActive && !IsPaused）
    if (!this._isActive() || this._isPaused()) return;
    e.preventDefault();
    this._options.onWheel?.(normalizeWheelEvent(e));
  }

  _onPointerDown(e) {
    if (!this._isActive()) return;
    // 游戏导航 + 已捕获：右键 = 取消选中所有（准星模式下的"反选"操作）
    if (e.pointerType === 'mouse' && e.button === 2) {
      if (this.isCaptured) {
        e.preventDefault();
        this._options.onDeselectAll?.();
      }
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.isCaptured) {
      // 已捕获：左键 = 选中准星（屏幕中心）指向的对象；按住 CTRL/⌘ = 加入多选而不是替换选择集。
      // 未捕获时的左键仍走下面的捕获流程，捕获那一刻的点击不做拾取。
      this._options.onCenterPick?.({ additive: !!(e.ctrlKey || e.metaKey) });
      return;
    }
    this._options.onCaptureRequested?.();
    this.requestCapture().then((ok) => {
      if (!ok) this._options.onCaptureFailed?.(this.capture.lastError || '');
    });
  }

  _onContextMenu(e) {
    // 游戏导航中不弹浏览器右键菜单（右键承担"取消选中"语义，且锁定状态下弹菜单没有意义）
    if (this._isActive()) e.preventDefault();
  }

  _onPointerLockChange() {
    const captured = this.isCaptured;
    // 自己发起的释放（切换模式/暂停）不算"用户按了 Esc"
    const intentional = captured ? false : this.capture.consumeIntentionalExit();
    this._options.onCaptureChanged?.({ captured, intentional });
  }

  _onBlur() {
    this._hasFocus = false;
    // 窗口失焦：清空所有按键状态、停止相机移动（原件 Pause('focus')）
    this.input.reset();
    this.capture.release();
    this._options.onFocusLost?.();
  }

  _onFocus() {
    this._hasFocus = true;
    this.input.reset();
    this._options.onFocusRestored?.();
  }
}

/** 原插件 `NormalizeWheel`：Win32 一格 = 120，超过按格换算，再钳到 ±8。
 *  浏览器没有 120 的概念，按 `deltaMode` 先把 deltaY 换算成"格"：
 *    deltaMode 0 = 像素（Chrome/Edge 一格约 100px）
 *    deltaMode 1 = 行（Firefox 一格 3 行）
 *    deltaMode 2 = 页（极少见，按一页 = 8 格处理）
 */
export function normalizeWheelEvent(e) {
  const raw0 = e.deltaMode === 1 ? (e.deltaY / 3) : e.deltaMode === 2 ? (e.deltaY * 8)
    : (e.deltaY / 100);
  const notches = -raw0;                                   // 向下滚 = 缩小，与 Win32 符号一致
  return Math.max(-8, Math.min(8, notches));
}

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}
