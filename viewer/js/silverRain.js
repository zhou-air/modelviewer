import * as THREE from 'three';

/** Screen-space background only. Recycle a fixed pool instead of accumulating particles. */
export class SilverRain {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.context = this.canvas.getContext('2d');
    this.lines = Array.from({ length: 600 }, () => ({
      x: Math.random(), y: Math.random() * 820,
      speed: 10 + Math.random() * 100, length: 12 + Math.random() * 65,
      width: 0.5 + Math.random(), alpha: 0.15 + Math.random() * 0.7,
    }));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.name = '__ENVIRONMENT_SILVER_RAIN__';
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.update(0);
  }

  update(deltaSeconds) {
    const { context: ctx, canvas } = this;
    const dt = Math.max(0, Math.min(deltaSeconds, 0.1));
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const line of this.lines) {
      line.y = (line.y + line.speed * dt) % (canvas.height + 100);
      const bottom = line.y;
      const x = line.x * canvas.width;
      const gradient = ctx.createLinearGradient(x, bottom - line.length, x, bottom);
      gradient.addColorStop(0, 'rgba(160,170,180,0)');
      gradient.addColorStop(1, `rgba(220,225,232,${line.alpha})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = line.width;
      ctx.beginPath();
      ctx.moveTo(x, bottom - line.length);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }
}
