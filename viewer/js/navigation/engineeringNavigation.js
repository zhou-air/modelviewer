/** 工程导航控制器：相机运动 / 偏航 / 俯仰。
 *
 * 来源：NavisGameNavigation V0.1 的
 *   Core/CameraFrame.cs · Core/CameraMath.cs · Core/NavigationDefaults.cs
 *   Navigation/GameNavigationController.cs（去掉宿主部分）
 *   Core/CrosshairModel.cs（可见性判定）
 *
 * 这里是**逐行等价端口**，不是"类似实现"：
 *   · `CameraFrame` / `CameraMath` 与 C# 版同名同式，叉积约定（this × other，右手系）与 THREE 一致，
 *     所以 `rotateAroundAxis` 直接用 `Vector3.applyAxisAngle`（同为右手系 Rodrigues 公式）。
 *   · 组合移动**只在最后 normalize 一次**（`composeMovement`），这就是"W+D 不比 W 快"的唯一原因，
 *     不要改成"三轴各自乘系数再相加"。
 *   · W/S 走的是 `horizontalForward` 的水平投影，所以仰视/俯视时不会改变高度。
 *   · A/D 用的是 `frame.right`——由**当前** yaw 派生，不是初始相机右轴。
 *   · Space/Shift 永远沿**世界**上轴（WorldUp），不沿镜头。
 */

import * as THREE from 'three';
import {
  MouseSensitivityRadiansPerPixel,
  MaxPitchRadians,
  NavigationDefaults,
  WORLD_UNITS_PER_METER,
} from './navigationSettings.js';
import { NavigationInputSource } from './inputState.js';

/** 原插件 `Core/CameraFrame.cs`：WorldUp / HorizontalForward / Pitch 三个状态量，
 *  Right 与 Forward 是每帧派生的（不是存下来的向量）。 */
export class CameraFrame {
  constructor(worldUp, horizontalForward, pitchRadians) {
    this.worldUp = worldUp.clone().normalize();
    this.horizontalForward = horizontalForward.clone().normalize();
    this.pitchRadians = pitchRadians;
  }

  /** `HorizontalForward × WorldUp` */
  get right() {
    return this.horizontalForward.clone().cross(this.worldUp).normalize();
  }

  /** `normalize(HorizontalForward·cos(pitch) + WorldUp·sin(pitch))` */
  get forward() {
    return this.horizontalForward.clone()
      .multiplyScalar(Math.cos(this.pitchRadians))
      .addScaledVector(this.worldUp, Math.sin(this.pitchRadians))
      .normalize();
  }
}

/** 原插件 `Core/CameraMath.cs` 的逐函数端口（导出供自动化实测直接断言） */
export const CameraMath = {
  EPSILON: NavigationDefaults.Epsilon,

  clamp(value, minimum, maximum) {
    return value < minimum ? minimum : value > maximum ? maximum : value;
  },

  projectOntoPlane(vector, unitNormal) {
    return vector.clone().addScaledVector(unitNormal, -vector.dot(unitNormal));
  },

  /** 建帧。近乎垂直时用相机右轴兜底推导水平前向（原件的第二个分支）。 */
  createFrame(forward, cameraRight, worldUp) {
    const up = worldUp.clone().normalize();
    if (up.lengthSq() <= this.EPSILON) throw new Error('World Up 不能为零向量。');

    const normalizedForward = forward.clone().normalize();
    if (normalizedForward.lengthSq() <= this.EPSILON) throw new Error('相机 Forward 不能为零向量。');

    let horizontal = this.projectOntoPlane(normalizedForward, up).normalize();
    if (horizontal.lengthSq() <= this.EPSILON) {
      const horizontalRight = this.projectOntoPlane(cameraRight, up).normalize();
      horizontal = up.clone().cross(horizontalRight).normalize();
    }
    if (horizontal.lengthSq() <= this.EPSILON) throw new Error('无法从当前视点推导水平前向。');

    const pitch = this.clamp(
      Math.asin(this.clamp(normalizedForward.dot(up), -1.0, 1.0)),
      -MaxPitchRadians, MaxPitchRadians);
    return new CameraFrame(up, horizontal, pitch);
  },

  /** `yaw = -deltaX·rpp` 绕 WorldUp 旋转水平前向；`pitch -= deltaY·rpp` 再夹到 ±89°。 */
  applyMouseLook(frame, deltaX, deltaY, radiansPerPixel = MouseSensitivityRadiansPerPixel) {
    const yaw = -deltaX * radiansPerPixel;
    frame.horizontalForward = this.rotateAroundAxis(frame.horizontalForward, frame.worldUp, yaw).normalize();
    frame.pitchRadians = this.clamp(
      frame.pitchRadians - deltaY * radiansPerPixel,
      -MaxPitchRadians, MaxPitchRadians);
  },

  /** 组合移动：三轴相加后**归一化**——组合不超速靠的就是这一句。 */
  composeMovement(frame, forwardAxis, rightAxis, upAxis) {
    const movement = frame.horizontalForward.clone().multiplyScalar(forwardAxis);
    movement.addScaledVector(frame.right, rightAxis);
    movement.addScaledVector(frame.worldUp, upAxis);
    return movement.normalize();
  },

  /** Rodrigues，与 C# 版同式；THREE 的 applyAxisAngle 同为右手系同一公式。 */
  rotateAroundAxis(vector, unitAxis, radians) {
    return vector.clone().applyAxisAngle(unitAxis, radians);
  },
};

/** 原插件 `Core/CrosshairModel.cs > CrosshairVisibility.ShouldRender` */
export const CrosshairVisibility = {
  shouldRender(active, paused, captured, foreground) {
    return !!(active && !paused && captured && foreground);
  },
};

export class EngineeringNavigation {
  /**
   * @param {object} options
   * @param {THREE.PerspectiveCamera} options.camera  宿主相机（原 Navisworks Viewpoint 的位置）
   * @param {HTMLElement} options.canvas              三维视图（原 Navisworks Viewport）
   * @param {THREE.Vector3} [options.worldUp]         宿主向上轴（原 viewpoint.WorldUpVector）
   * @param {object} options.settings                 NavigationSettingsStore
   */
  constructor({ camera, canvas, worldUp, settings, onRequestModeToggle, onStateChange,
                onRequestCenterPick, onRequestDeselectAll }) {
    this.camera = camera;
    this.canvas = canvas;
    this.settings = settings;
    this.worldUp = (worldUp ? worldUp.clone() : new THREE.Vector3(0, 1, 0)).normalize();
    if (this.worldUp.lengthSq() <= CameraMath.EPSILON) this.worldUp.set(0, 1, 0);

    this.onStateChange = onStateChange;

    this.active = false;
    this.paused = false;
    this.frame = null;
    this.pendingZoomNotches = 0;
    this.pauseReason = null;
    this.interacting = false;
    this.failure = null;

    // DOM 接线层：键盘 / 鼠标 / 焦点 / Pointer Lock（监听器只注册一次）
    this.inputSource = new NavigationInputSource(canvas, {
      isActive: () => this.active,
      isPaused: () => this.paused,
      onToggleNavigation: () => onRequestModeToggle?.(),
      // Esc 只释放鼠标捕获（模式粘滞）：导航模式只能由 F8 / 工具条按钮切换
      onEscape: () => this.inputSource.releaseCapture(),
      onWheel: (notches) => { this.pendingZoomNotches += notches; },
      // 场景内的一次点击 = 原插件的 MouseDown：暂停中则恢复，否则开始捕获
      onCaptureRequested: () => { if (this.paused) this.resume(); },
      // 已捕获时的左键 = 选中准星指向的对象（opts 里带 Ctrl 多选标记）；右键 = 取消选中所有
      onCenterPick: (opts) => onRequestCenterPick?.(opts),
      onDeselectAll: () => onRequestDeselectAll?.(),
      onCaptureChanged: ({ captured }) => {
        // 捕获丢失即清空按键与未消费的鼠标增量：否则重新捕获的瞬间
        // 残留输入会生效，表现为"自动移动 / 视角瞬移"
        if (!captured) this.inputSource.input.reset();
        // 捕获丢失（Esc / 失焦等）不退出游戏模式，只更新准星与提示
        this.onStateChange?.();
      },
      onCaptureFailed: (message) => { this.failure = message; this.onStateChange?.(); },
      onFocusLost: () => { this.pause('focus'); this.onStateChange?.(); },
      onFocusRestored: () => { this.onStateChange?.(); },
    });
    this.inputSource.attach();
    // 按键状态：对应原插件的 `InputState _input`（名字保持一致，便于与源码逐行对照）
    this.input = this.inputSource.input;
  }

  get captured() { return this.inputSource.isCaptured; }
  get shouldShowCrosshair() {
    return CrosshairVisibility.shouldRender(
      this.active, this.paused, this.captured, this.inputSource.hasFocus);
  }

  /** 原 `Start()`：校验宿主 → 建帧 → 复位输入。宿主校验部分已由 viewer3d 落在 Web 等价条件上。 */
  start() {
    if (this.active) return null;
    if (!this.camera || !this.camera.isPerspectiveCamera) return '游戏导航仅支持透视相机。';

    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const worldUp = this.camera.up.clone();
    try {
      this.frame = CameraMath.createFrame(
        forward, cameraRight, worldUp.lengthSq() > CameraMath.EPSILON ? worldUp : this.worldUp);
    } catch (e) {
      return '无法从当前视角建立导航基准：' + e.message;
    }

    this.active = true;
    this.paused = false;
    this.pauseReason = null;
    this.pendingZoomNotches = 0;
    this.failure = null;
    this.input.reset();
    this.onStateChange?.();
    return null;
  }

  /** 原 `Stop(restorePreviousTool)`：复位状态、释放捕获，**保留当前相机位姿**。 */
  stop() {
    if (!this.active) { this.inputSource.releaseCapture(); return; }
    this.active = false;
    this.paused = false;
    this.pauseReason = null;
    this.pendingZoomNotches = 0;
    this.frame = null;
    this.input.reset();
    this.inputSource.releaseCapture();
    this.onStateChange?.();
  }

  /** 原 `Pause(reason)`：清空所有按键、释放鼠标捕获；模式本身保持开启。 */
  pause(reason) {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.pauseReason = reason;
    this.input.reset();
    this.inputSource.releaseCapture();
    this.onStateChange?.();
  }

  /** 原 `ResumeCapture`：复位输入、重新捕获（Web 侧重新捕获由点击触发） */
  resume() {
    if (!this.active) return;
    this.paused = false;
    this.pauseReason = null;
    this.input.reset();
    this.onStateChange?.();
  }

  /** 相机被外部直接移动（如复位视角 / Fit）后，从当前位姿重建导航基准帧。
   *  不重建的话 frame 与实际朝向脱节，下一次视角转动会表现为"瞬移"回旧方向。 */
  rebase() {
    if (!this.active) return;
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const worldUp = this.camera.up.clone();
    try {
      this.frame = CameraMath.createFrame(
        forward, cameraRight, worldUp.lengthSq() > CameraMath.EPSILON ? worldUp : this.worldUp);
      this.input.reset();               // 顺手清残留输入，避免复位瞬间带着旧增量
    } catch { /* 极端视角下建帧失败：保持旧帧，不打断导航 */ }
  }

  /** 每帧调用。返回是否消费了本帧（事件驱动的 DOM 输入，无返回值语义，仅供调试）。 */
  update(deltaSeconds) {
    this.interacting = false;
    if (!this.active) return false;

    // 原件在定时器里也会复核前台状态（IsNavisworksForeground），这里同样兜一层
    if (!this.inputSource.hasFocus) { this.pause('focus'); return false; }
    if (this.paused) return false;

    const elapsed = CameraMath.clamp(
      Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, NavigationDefaults.MaximumDeltaSeconds);

    // ---- 视角：鼠标增量每帧只消费一次（对应 UpdateViewpoint 开头）
    const delta = this.input.consumeMouseDelta();
    const orientationChanged = Math.abs(delta.x) > CameraMath.EPSILON || Math.abs(delta.y) > CameraMath.EPSILON;
    if (orientationChanged) {
      CameraMath.applyMouseLook(this.frame, delta.x, delta.y, MouseSensitivityRadiansPerPixel);
    }

    // ---- 移动
    const axes = this.input.getAxes();
    const movementDirection = CameraMath.composeMovement(this.frame, axes.forward, axes.right, axes.up);
    const hasMovement = movementDirection.lengthSq() > CameraMath.EPSILON && elapsed > 0;

    // ---- 滚轮 Zoom（原件回落到 HeightField 的那套公式）
    const zoomChanged = this.applyPendingZoom();

    this.interacting = orientationChanged || hasMovement || zoomChanged;
    if (!orientationChanged && !hasMovement && !zoomChanged) return true;

    if (orientationChanged) this._applyOrientation();
    if (hasMovement) this._applyMovement(movementDirection, axes.forward, elapsed);
    return true;
  }

  /** 对应 `viewpoint.AlignDirection(forward)` + `AlignUp(worldUp)` + `CopyViewpointFrom(..., JumpCut)` */
  _applyOrientation() {
    const forward = this.frame.forward;
    this.camera.up.copy(this.frame.worldUp);
    this.camera.lookAt(
      this.camera.position.x + forward.x,
      this.camera.position.y + forward.y,
      this.camera.position.z + forward.z);
  }

  /** 对应速度计算 + `viewpoint.Position.Add(displacement)` */
  _applyMovement(direction, forwardAxis, elapsed) {
    let speed = this.settings.normalSpeedMetersPerSecond * WORLD_UNITS_PER_METER;
    // 原式：只有"向前"才吃加速倍率（S / 纯 A-D / 纯升降都不加速）
    if (this.input.isSprinting && forwardAxis > 0) speed *= this.settings.sprintMultiplier;
    this.camera.position.addScaledVector(direction, speed * elapsed);
  }

  /** 对应 `ApplyPendingWheelFallback`：原插件优先让宿主原生 Zoom 生效，仅在原生未改变相机时
   *  回落到视场角公式。Web 的 Game 模式下 OrbitControls 已停用（不允许两个控制器同时响应输入），
   *  原生通道不存在，因此这里直接采用同一套回落公式——照抄源码，不是新设计。
   *
   *  若日后确认想要 Navisworks 那种"推拉"手感，把下面两行换成沿 `this.frame.forward` 平移即可，
   *  其余逻辑（notches 归一化、每帧消费、与移动/视角的互不干扰）都不需要动。 */
  applyPendingZoom() {
    if (Math.abs(this.pendingZoomNotches) <= CameraMath.EPSILON) return false;
    const notches = this.pendingZoomNotches;
    this.pendingZoomNotches = 0;

    const nextFov = this.camera.fov * Math.pow(0.9, notches);
    this.camera.fov = CameraMath.clamp(
      nextFov,
      NavigationDefaults.MinimumFieldOfViewDegrees,
      NavigationDefaults.MaximumFieldOfViewDegrees);
    this.camera.updateProjectionMatrix();
    return true;
  }

  dispose() {
    this.stop();
    this.inputSource.detach();
  }

  /** 供自动化实测读取（本项目的既有约定：`window.__viewer` 暴露运行状态） */
  state() {
    const frame = this.frame;
    return {
      active: this.active,
      paused: this.paused,
      pauseReason: this.pauseReason,
      captured: this.captured,
      hasFocus: this.inputSource.hasFocus,
      crosshair: this.shouldShowCrosshair,
      worldUp: this.worldUp.toArray(),
      horizontalForward: frame ? frame.horizontalForward.toArray() : null,
      right: frame ? frame.right.toArray() : null,
      // 视线方向（含俯仰），用于验证"W 沿水平投影"与"仰视不改变高度"
      forward: frame ? frame.forward.toArray() : null,
      // 绕世界 Y 轴的水平朝向，取值 (-π, π]；连续旋转需在测试侧展开累计
      headingRadians: frame ? Math.atan2(frame.horizontalForward.x, frame.horizontalForward.z) : null,
      pitchRadians: frame ? frame.pitchRadians : null,
      pitchDegrees: frame ? frame.pitchRadians * 180 / Math.PI : null,
      cameraPosition: this.camera.position.toArray(),
      cameraFov: this.camera.fov,
      sprinting: this.input.isSprinting,
      axes: { ...this.input.getAxes() },
      pressed: [...this.input.snapshot().pressed],
      interacting: this.interacting,
      speedMetersPerSecond: this.settings.normalSpeedMetersPerSecond,
      sprintMultiplier: this.settings.sprintMultiplier,
      pointerLockSupported: typeof this.canvas.requestPointerLock === 'function',
      captureFailure: this.failure || null,
    };
  }
}
