import * as THREE from 'three';
import { ENGINEERING_AXES } from './coordinateMapping.js';

const SIZE = 94;
const DPR_CAP = 2;
const COLORS = Object.freeze({
  ink: '#27323a',
  muted: '#71808a',
  ring: 'rgba(89, 105, 116, .48)',
  ringSoft: 'rgba(104, 120, 130, .18)',
  north: '#1d5f91',
  hover: '#b66a1d',
  arrow: '#3e6f8f',
});

/**
 * Fixed-size engineering compass overlay.
 *
 * This is deliberately a DOM canvas rather than a child of the model scene:
 * it cannot enter the model tree, model raycast, visibility/isolation state,
 * or post-processing passes. The only model state it consumes is camera pose.
 */
export class OrientationGizmo {
  constructor({ mainCamera, parent, onDirection } = {}) {
    this.mainCamera = mainCamera;
    this.onDirection = onDirection || (() => {});
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orientation-gizmo';
    this.canvas.setAttribute('aria-label', '工程方向罗盘：N、E、S、W、U、D');
    this.canvas.setAttribute('role', 'img');
    this.canvas.title = '点击 N/E/S/W 切换正交方向，点击 U/D 切换顶视图/底视图';
    parent?.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    this.canvas.width = SIZE * this.pixelRatio;
    this.canvas.height = SIZE * this.pixelRatio;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    this.ctx.scale(this.pixelRatio, this.pixelRatio);

    this.hovered = null;
    this.lastQuaternion = new THREE.Quaternion(NaN, NaN, NaN, NaN);
    this.dirty = true;
    this._onPointerMove = (event) => this._handlePointer(event, false);
    this._onPointerLeave = () => {
      if (this.hovered !== null) {
        this.hovered = null;
        this.dirty = true;
        this._draw();
      }
    };
    this._onClick = (event) => this._handlePointer(event, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('click', this._onClick);
    this._draw();
  }

  _handlePointer(event, activate) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this._hitTest(x, y);
    if (activate) {
      if (hit) this.onDirection(hit);
      return;
    }
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.dirty = true;
      this._draw();
    }
  }

  _hitTest(x, y) {
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.hypot(dx, dy);
    // U/D live above/below the ring; test them first so they never collide
    // with the N/S ring labels at the same screen x coordinate.
    if (Math.abs(dx) <= 12 && y >= 0 && y <= 10) return 'U';
    if (Math.abs(dx) <= 12 && y >= SIZE - 10 && y <= SIZE) return 'D';
    if (r >= 20 && r <= 39) {
      const angle = Math.atan2(dx, -dy);
      const index = Math.round((angle / (Math.PI / 2) + 4) % 4) % 4;
      return ['N', 'E', 'S', 'W'][index];
    }
    // U/D are deliberately narrow center-axis hit zones, not large buttons.
    if (Math.abs(dx) <= 12 && y >= 3 && y < cy - 25) return 'U';
    if (Math.abs(dx) <= 12 && y > cy + 25 && y <= SIZE - 3) return 'D';
    return null;
  }

  _cameraHeading() {
    const forward = this.mainCamera.getWorldDirection(new THREE.Vector3());
    const north = ENGINEERING_AXES.N;
    const east = ENGINEERING_AXES.E;
    const horizontal = forward.clone().addScaledVector(
      ENGINEERING_AXES.U, -forward.dot(ENGINEERING_AXES.U));
    if (horizontal.lengthSq() < 1e-8) return this.lastHeading || Math.PI;
    horizontal.normalize();
    this.lastHeading = Math.atan2(horizontal.dot(east), horizontal.dot(north));
    return this.lastHeading;
  }

  _text(text, x, y, { color = COLORS.ink, size = 10, weight = 600 } = {}) {
    this.ctx.fillStyle = color;
    this.ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(text, x, y);
  }

  _drawArrow(x, y, angle, length, color, width = 1.15) {
    const ctx = this.ctx;
    const tipX = x + Math.sin(angle) * length;
    const tipY = y - Math.cos(angle) * length;
    const left = angle - Math.PI * 0.86;
    const right = angle + Math.PI * 0.86;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + Math.sin(left) * 4.5, tipY - Math.cos(left) * 4.5);
    ctx.lineTo(tipX + Math.sin(right) * 4.5, tipY - Math.cos(right) * 4.5);
    ctx.closePath();
    ctx.fill();
  }

  _draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Low-opacity circular plate: enough contrast over dense model geometry,
    // without becoming a panel or a game-style colored badge.
    ctx.fillStyle = 'rgba(247, 249, 250, .74)';
    ctx.beginPath();
    ctx.arc(cx, cy, 43.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ringSoft;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Compass ring and four subtle cardinal ticks.
    ctx.strokeStyle = COLORS.ring;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 30.5, 0, Math.PI * 2);
    ctx.stroke();
    for (const [name, angle] of [['N', 0], ['E', Math.PI / 2], ['S', Math.PI], ['W', -Math.PI / 2]]) {
      const emphasis = name === 'N';
      const inner = 27.5;
      const outer = emphasis ? 36 : 34;
      const x1 = cx + Math.sin(angle) * inner;
      const y1 = cy - Math.cos(angle) * inner;
      const x2 = cx + Math.sin(angle) * outer;
      const y2 = cy - Math.cos(angle) * outer;
      ctx.strokeStyle = this.hovered === name ? COLORS.hover : (emphasis ? COLORS.north : COLORS.ring);
      ctx.lineWidth = emphasis || this.hovered === name ? 1.7 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const labelRadius = 32;
      this._text(name, cx + Math.sin(angle) * labelRadius,
        cy - Math.cos(angle) * labelRadius,
        { color: this.hovered === name ? COLORS.hover : (emphasis ? COLORS.north : COLORS.ink), size: emphasis ? 11 : 10, weight: emphasis ? 700 : 600 });
    }

    // Center heading arrow: its bearing is derived from the camera's current
    // engineering-world forward vector, so it updates in Orbit and Game modes.
    this._drawArrow(cx, cy, this._cameraHeading(), 14, this.hovered === 'N' ? COLORS.hover : COLORS.arrow, 1.25);
    ctx.fillStyle = COLORS.ring;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.1, 0, Math.PI * 2);
    ctx.fill();

    // U/D are thin vertical arrows on the center axis, not circular buttons.
    const axisColor = (name) => this.hovered === name ? COLORS.hover : COLORS.muted;
    ctx.lineWidth = this.hovered === 'U' ? 1.7 : 1;
    ctx.strokeStyle = axisColor('U');
    ctx.beginPath(); ctx.moveTo(cx, cy - 27); ctx.lineTo(cx, cy - 34); ctx.stroke();
    this._drawArrow(cx, cy - 28, 0, 6, axisColor('U'), this.hovered === 'U' ? 1.7 : 1);
    this._text('U', cx, cy - 42, { color: axisColor('U'), size: 9, weight: 600 });
    ctx.lineWidth = this.hovered === 'D' ? 1.7 : 1;
    ctx.strokeStyle = axisColor('D');
    ctx.beginPath(); ctx.moveTo(cx, cy + 27); ctx.lineTo(cx, cy + 34); ctx.stroke();
    this._drawArrow(cx, cy + 28, Math.PI, 6, axisColor('D'), this.hovered === 'D' ? 1.7 : 1);
    this._text('D', cx, cy + 42, { color: axisColor('D'), size: 9, weight: 600 });
    this.dirty = false;
  }

  update() {
    if (!this.mainCamera) return;
    if (this.lastQuaternion.angleTo(this.mainCamera.quaternion) < 1e-7 && !this.dirty) return;
    this.lastQuaternion.copy(this.mainCamera.quaternion);
    this._draw();
  }

  dispose() {
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.remove();
  }
}
