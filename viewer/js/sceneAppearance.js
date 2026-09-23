import * as THREE from 'three';
import { ENVIRONMENT_PRESETS, ENVIRONMENT_MODES } from './appearance.js';
import { SilverRain } from './silverRain.js';

function noRaycast(object) {
  object.raycast = () => {};
  object.userData.nonSelectable = true;
  return object;
}

/** 与模型 root 平级的场景外观层。地板不进树、不参与拾取/显隐/测量。 */
export class SceneAppearance {
  constructor(scene, settings = {}) {
    const { backgroundColor = '#eef1f3', groundEnabled = false, groundColor = '#d7dde3' } = settings;
    this.scene = scene;
    this.ground = null;
    this.modelBox = null;
    this.floorPlanY = null;
    this.backgroundColor = new THREE.Color(backgroundColor);
    this.environmentMode = 'solid';
    this.environmentPreset = 'engineering-light';
    this.environmentTexture = '';
    this.environmentColors = { ...ENVIRONMENT_PRESETS['engineering-light'] };
    delete this.environmentColors.label;
    this.backgroundTexture = null;
    this.environmentStatus = 'ready';
    this.environmentError = null;
    this._environmentGeneration = 0;
    this.groundColor = new THREE.Color(groundColor);
    this.groundEnabled = !!groundEnabled;
    this.applyEnvironment(settings);
  }

  setBackgroundColor(color) {
    this.backgroundColor.set(color);
    if (this.environmentMode === 'solid') this._showSolidBackground();
    return `#${this.backgroundColor.getHexString()}`;
  }

  _disposeBackgroundTexture() {
    this.silverRain = null;
    if (!this.backgroundTexture) return;
    if (this.scene.background === this.backgroundTexture) this.scene.background = null;
    this.backgroundTexture.dispose();
    this.backgroundTexture = null;
  }

  _showSolidBackground() {
    this._disposeBackgroundTexture();
    this.scene.background = this.backgroundColor;
    this.environmentStatus = 'ready';
    this.environmentError = null;
  }

  _makeHorizonTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, this.environmentColors.skyTopColor);
    gradient.addColorStop(0.46, this.environmentColors.skyHorizonColor);
    gradient.addColorStop(0.54, this.environmentColors.groundHorizonColor);
    gradient.addColorStop(1, this.environmentColors.groundFarColor);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = '__ENVIRONMENT_HORIZON__';
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  _showHorizonBackground() {
    this._disposeBackgroundTexture();
    this.backgroundTexture = this._makeHorizonTexture();
    this.scene.background = this.backgroundTexture;
    this.environmentStatus = 'ready';
    this.environmentError = null;
  }

  async _showTextureBackground(url, generation) {
    this._disposeBackgroundTexture();
    this.scene.background = this.backgroundColor;
    if (!url) {
      this.environmentStatus = 'empty';
      this.environmentError = '未选择环境贴图';
      return false;
    }
    this.environmentStatus = 'loading';
    this.environmentError = null;
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      if (generation !== this._environmentGeneration || this.environmentMode !== 'texture') {
        texture.dispose();
        return false;
      }
      const width = Number(texture.image?.naturalWidth || texture.image?.width || 0);
      const height = Number(texture.image?.naturalHeight || texture.image?.height || 0);
      if (!width || !height || Math.abs(width / height - 2) > 0.02) {
        texture.dispose();
        throw new Error(`环境贴图必须为 2:1，当前 ${width}×${height}`);
      }
      texture.name = '__ENVIRONMENT_TEXTURE__';
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      this.backgroundTexture = texture;
      this.scene.background = texture;
      this.environmentStatus = 'ready';
      return true;
    } catch (error) {
      if (generation !== this._environmentGeneration) return false;
      this.scene.background = this.backgroundColor;
      this.environmentStatus = 'error';
      this.environmentError = error?.message || String(error);
      return false;
    }
  }

  applyEnvironment(settings = {}) {
    this.environmentMode = ENVIRONMENT_MODES.includes(settings.environmentMode)
      ? settings.environmentMode : this.environmentMode;
    if (settings.environmentPreset) this.environmentPreset = settings.environmentPreset;
    if (typeof settings.environmentTexture === 'string') this.environmentTexture = settings.environmentTexture;
    if (settings.environmentColors) this.environmentColors = { ...this.environmentColors, ...settings.environmentColors };
    const generation = ++this._environmentGeneration;
    if (this.environmentMode === 'silver-rain') {
      this._disposeBackgroundTexture();
      this.silverRain = new SilverRain();
      this.backgroundTexture = this.silverRain.texture;
      this.scene.background = this.backgroundTexture;
      this.environmentStatus = 'ready';
      this.environmentError = null;
      return Promise.resolve(true);
    }
    if (this.environmentMode === 'solid') {
      this._showSolidBackground();
      return Promise.resolve(true);
    }
    if (this.environmentMode === 'horizon') {
      this._showHorizonBackground();
      return Promise.resolve(true);
    }
    return this._showTextureBackground(this.environmentTexture, generation);
  }

  setEnvironmentMode(mode) { return this.applyEnvironment({ environmentMode: mode }); }

  update(deltaSeconds) { this.silverRain?.update(deltaSeconds); }

  setEnvironmentPreset(preset) {
    const colors = ENVIRONMENT_PRESETS[preset];
    if (!colors) return Promise.resolve(false);
    const { label, ...environmentColors } = colors;
    return this.applyEnvironment({ environmentPreset: preset, environmentColors });
  }

  setEnvironmentColors(colors) {
    return this.applyEnvironment({ environmentPreset: 'custom', environmentColors: colors });
  }

  setEnvironmentTexture(url) { return this.applyEnvironment({ environmentTexture: url }); }

  setGroundColor(color) {
    this.groundColor.set(color);
    if (this.ground?.material?.color) this.ground.material.color.copy(this.groundColor);
    return `#${this.groundColor.getHexString()}`;
  }

  setGroundEnabled(enabled) {
    this.groundEnabled = !!enabled;
    this._syncGround();
    return this.groundEnabled;
  }

  /** 在模型或 FloorPlan 就绪后调用；切换模型时只重建这一个独立对象。 */
  syncGround(modelBox, floorPlanY = null) {
    this.modelBox = modelBox?.clone?.() || null;
    this.floorPlanY = Number.isFinite(floorPlanY) ? floorPlanY : null;
    this._syncGround();
  }

  _groundY() {
    const minY = this.modelBox.min.y;
    const size = this.modelBox.getSize(new THREE.Vector3());
    const modelOffset = Math.max(0.004, Math.min(0.05, size.length() * 1e-5));
    // FloorPlanGroup 位于 minY - floorOffset；地板再低一个小间隙，避免遮挡和闪烁。
    const floorPlanOffset = this.floorPlanY == null ? modelOffset : Math.max(0.002, minY - this.floorPlanY);
    const gap = Math.max(0.001, Math.min(0.02, floorPlanOffset * 0.5));
    return minY - Math.max(modelOffset, floorPlanOffset + gap);
  }

  _syncGround() {
    this._disposeGround();
    if (!this.groundEnabled || !this.modelBox || this.modelBox.isEmpty()) return;

    const size = this.modelBox.getSize(new THREE.Vector3());
    const center = this.modelBox.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1);
    const margin = Math.max(0.5, span * 0.08);
    const geometry = new THREE.PlaneGeometry(Math.max(size.x, 1) + margin * 2,
      Math.max(size.z, 1) + margin * 2);
    const material = new THREE.MeshStandardMaterial({
      color: this.groundColor,
      roughness: 0.92,
      metalness: 0,
    });
    const ground = noRaycast(new THREE.Mesh(geometry, material));
    ground.name = '__GROUND_PLANE__';
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, this._groundY(), center.z);
    ground.renderOrder = 0;
    this.ground = ground;
    this.scene.add(ground);
  }

  _disposeGround() {
    if (!this.ground) return;
    this.scene.remove(this.ground);
    this.ground.geometry?.dispose();
    this.ground.material?.dispose();
    this.ground = null;
  }

  state() {
    return {
      backgroundColor: `#${this.backgroundColor.getHexString()}`,
      environmentMode: this.environmentMode,
      environmentPreset: this.environmentPreset,
      environmentTexture: this.environmentTexture,
      environmentColors: { ...this.environmentColors },
      environmentStatus: this.environmentStatus,
      environmentError: this.environmentError,
      environmentBackgroundType: this.scene.background?.isTexture ? 'texture' : 'color',
      groundEnabled: this.groundEnabled,
      groundColor: `#${this.groundColor.getHexString()}`,
      groundVisible: !!this.ground?.visible,
      groundY: this.ground ? +this.ground.position.y.toFixed(6) : null,
      groundSize: this.ground ? [this.ground.geometry.parameters.width, this.ground.geometry.parameters.height] : null,
    };
  }

  dispose() {
    this._environmentGeneration++;
    this._disposeBackgroundTexture();
    this._disposeGround();
  }
}
