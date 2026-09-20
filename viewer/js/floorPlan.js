import * as THREE from 'three';

const FLOORPLAN_SCHEMA = 'pdms-equipment-floorplan/1';
const FLOORPLAN_UNITS = 'mm';
const FLOORPLAN_COORDS = 'PDMS_WORLD_XY_Z_UP';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function noRaycast(object) {
  object.raycast = () => {};
  object.userData.nonSelectable = true;
  return object;
}

function disposeGroup(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of list) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

/**
 * 独立于模型 root 的设备定位底图。
 *
 * floorplan.json 保存 PDMS 世界坐标（mm、Z-up）。当前 RVM→GLB 固定执行：
 *   1. mm → m；2. 减去 rvmparser-origin；3. 绕 X 轴 -90°（Z-up → Y-up）。
 * 因此平面坐标映射为 Three.js (x, z) = (PDMS X-originX, -(PDMS Y-originY))。
 */
export class FloorPlanGroup extends THREE.Group {
  constructor({ document: floorplan, origin, modelBox, nodeByCanonical }) {
    super();
    this.name = 'FloorPlanGroup';
    this.userData.nonSelectable = true;
    this.floorplan = floorplan;
    this.origin = origin;
    this.modelBox = modelBox.clone();
    this.nodeByCanonical = nodeByCanonical;
    this.debugGroup = null;
    this.debugBuilt = false;
    this.debugVisible = false;

    this._validate();
    const size = this.modelBox.getSize(new THREE.Vector3());
    this.horizontalSpan = Math.max(size.x, size.z, 1);
    this.floorOffset = Math.max(0.002, Math.min(0.05, size.length() * 1e-5));
    this.floorY = this.modelBox.min.y - this.floorOffset;
    this.stats = {
      equipment: floorplan.equipment.length,
      positioned: 0,
      outlines: 0,
      outlineSegments: 0,
      labelBatches: 0,
      debugCenters: 0,
      floorY: this.floorY,
      floorOffset: this.floorOffset,
    };

    this._buildOutlines();
    this._buildLocationPoints();
    this._buildLabels();
    this.traverse(noRaycast);
  }

  _validate() {
    const d = this.floorplan;
    if (!d || d.schema !== FLOORPLAN_SCHEMA) throw new Error('floorplan.json schema 不受支持');
    if (d.units !== FLOORPLAN_UNITS) throw new Error('floorplan.json 不是 mm 单位');
    if (d.coordinateSystem !== FLOORPLAN_COORDS) throw new Error('floorplan.json 坐标系不受支持');
    if (!Array.isArray(d.equipment)) throw new Error('floorplan.json equipment 缺失');
    if (!Array.isArray(this.origin) || this.origin.length !== 3 || !this.origin.every(finite)) {
      throw new Error('GLB 缺少有效的 asset.extras.rvmparser-origin，不能可靠对齐底图');
    }
  }

  /** PDMS 世界 XY（mm）→ 当前 GLB/Three.js 水平 XZ（m，已中心化和转轴）。 */
  _xy(xMm, yMm, y = this.floorY) {
    return new THREE.Vector3(xMm / 1000 - this.origin[0], y, -(yMm / 1000 - this.origin[1]));
  }

  _positioned() {
    return this.floorplan.equipment.filter((e) => finite(e.x) && finite(e.y));
  }

  _buildOutlines() {
    const positions = [];
    for (const equipment of this.floorplan.equipment) {
      for (const outline of equipment.outlines || []) {
        const points = Array.isArray(outline.points) ? outline.points : [];
        if (points.length < 2) continue;
        let validSegments = 0;
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          if (!Array.isArray(a) || !Array.isArray(b)
              || !finite(a[0]) || !finite(a[1]) || !finite(b[0]) || !finite(b[1])) continue;
          const pa = this._xy(a[0], a[1]), pb = this._xy(b[0], b[1]);
          positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
          validSegments++;
        }
        if (validSegments) {
          this.stats.outlines++;
          this.stats.outlineSegments += validSegments;
        }
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.LineBasicMaterial({
      color: 0x157f8c, transparent: true, opacity: 0.82,
      depthTest: true, depthWrite: false,
    });
    const lines = noRaycast(new THREE.LineSegments(geometry, material));
    lines.name = 'FloorPlanOutlines';
    lines.renderOrder = 2;
    this.add(lines);
  }

  _buildLocationPoints() {
    const equipment = this._positioned();
    this.stats.positioned = equipment.length;
    if (!equipment.length) return;
    const r = Math.max(0.12, Math.min(1.2, this.horizontalSpan * 0.0025));
    const positions = [];
    for (const item of equipment) {
      const p = this._xy(item.x, item.y, this.floorY + this.floorOffset * 0.15);
      positions.push(p.x - r, p.y, p.z, p.x + r, p.y, p.z);
      positions.push(p.x, p.y, p.z - r, p.x, p.y, p.z + r);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.LineBasicMaterial({
      color: 0xd97706, transparent: true, opacity: 0.95,
      depthTest: true, depthWrite: false,
    });
    const points = noRaycast(new THREE.LineSegments(geometry, material));
    points.name = 'FloorPlanLocationPoints';
    points.renderOrder = 3;
    this.add(points);
  }

  /** 每 256 个位号合成一个纹理/网格批次，避免“一台设备一个 Sprite”的 draw call。 */
  _buildLabels() {
    const equipment = this._positioned().filter((item) => String(item.tag || '').trim());
    if (!equipment.length) return;
    const cols = 8, rows = 32, perPage = cols * rows;
    const cellW = 256, cellH = 64;
    const labelH = Math.max(0.32, Math.min(1.8, this.horizontalSpan * 0.005));
    const labelW = labelH * (cellW / cellH);
    const labelY = this.floorY + this.floorOffset * 0.3;

    for (let start = 0; start < equipment.length; start += perPage) {
      const page = equipment.slice(start, start + perPage);
      const canvas = document.createElement('canvas');
      canvas.width = cols * cellW;
      canvas.height = rows * cellH;
      const ctx = canvas.getContext('2d');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      const positions = [], uvs = [], indices = [];
      page.forEach((item, index) => {
        const col = index % cols, row = Math.floor(index / cols);
        const cx = col * cellW + cellW / 2, cy = row * cellH + cellH / 2;
        let fontSize = 30;
        ctx.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
        while (fontSize > 15 && ctx.measureText(item.tag || '').width > cellW - 12) {
          fontSize--;
          ctx.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
        }
        ctx.fillStyle = 'rgba(238,241,243,0.78)';
        ctx.fillRect(col * cellW + 2, row * cellH + 7, cellW - 4, cellH - 14);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(238,241,243,0.98)';
        ctx.strokeText(item.tag || '', cx, cy);
        ctx.fillStyle = '#0f4f58';
        ctx.fillText(item.tag || '', cx, cy);

        const p = this._xy(item.x, item.y, labelY);
        const base = positions.length / 3;
        const x0 = p.x - labelW / 2, x1 = p.x + labelW / 2;
        const z0 = p.z - labelH / 2, z1 = p.z + labelH / 2;
        positions.push(x0, p.y, z0, x1, p.y, z0, x1, p.y, z1, x0, p.y, z1);
        const u0 = col / cols, u1 = (col + 1) / cols;
        const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows;
        uvs.push(u0, v1, u1, v1, u1, v0, u0, v0);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      });

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({
        map: texture, transparent: true, alphaTest: 0.04,
        depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const labels = noRaycast(new THREE.Mesh(geometry, material));
      labels.name = `FloorPlanLabels-${this.stats.labelBatches + 1}`;
      labels.renderOrder = 4;
      this.add(labels);
      this.stats.labelBatches++;
    }
  }

  _buildDebug() {
    if (this.debugBuilt) return;
    this.debugBuilt = true;
    const floorPositions = [], centerPositions = [], connectors = [];
    const box = new THREE.Box3(), center = new THREE.Vector3();
    for (const item of this._positioned()) {
      const floor = this._xy(item.x, item.y, this.floorY + this.floorOffset * 0.6);
      floorPositions.push(floor.x, floor.y, floor.z);
      const canonical = item.tag?.startsWith('/') ? item.tag : `/${item.tag}`;
      const node = this.nodeByCanonical.get(canonical);
      if (!node) continue;
      box.setFromObject(node);
      if (box.isEmpty()) continue;
      box.getCenter(center);
      centerPositions.push(center.x, center.y, center.z);
      connectors.push(floor.x, floor.y, floor.z, center.x, center.y, center.z);
      this.stats.debugCenters++;
    }

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'FloorPlanDebug';
    const pointSize = Math.max(0.35, Math.min(2.5, this.horizontalSpan * 0.006));
    const addPoints = (positions, color, name) => {
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color, size: pointSize, sizeAttenuation: true,
        depthTest: false, depthWrite: false });
      const points = noRaycast(new THREE.Points(geometry, material));
      points.name = name;
      points.renderOrder = 20;
      this.debugGroup.add(points);
    };
    addPoints(floorPositions, 0x22c55e, 'FloorPlanDebugLocationPoints');
    addPoints(centerPositions, 0xff2d92, 'FloorPlanDebugModelCenters');
    if (connectors.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(connectors, 3));
      const material = new THREE.LineBasicMaterial({ color: 0x7c3aed, transparent: true,
        opacity: 0.45, depthTest: false, depthWrite: false });
      const lines = noRaycast(new THREE.LineSegments(geometry, material));
      lines.name = 'FloorPlanDebugConnectors';
      lines.renderOrder = 19;
      this.debugGroup.add(lines);
    }
    this.debugGroup.visible = this.debugVisible;
    this.debugGroup.traverse(noRaycast);
    this.add(this.debugGroup);
  }

  setDebugVisible(visible) {
    this.debugVisible = !!visible;
    if (this.debugVisible) this._buildDebug();
    if (this.debugGroup) this.debugGroup.visible = this.debugVisible;
    return this.debugVisible;
  }

  dispose() {
    disposeGroup(this);
    this.clear();
  }
}
