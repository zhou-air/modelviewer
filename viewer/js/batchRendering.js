import * as THREE from 'three';
import { mergeGeometries } from '../vendor/jsm/utils/BufferGeometryUtils.js';

const STATES = ['solid', 'selected', 'hover', 'ghost'];

/** Production batching layer built on top of the unchanged GLB hierarchy. */
export class BatchRenderingManager {
  constructor(model, { maxMeshesPerBatch = 64 } = {}) {
    this.model = model;
    this.maxMeshesPerBatch = maxMeshesPerBatch;
    this.group = new THREE.Group();
    this.group.name = '__BATCH_RENDERING__';
    this.entries = [];
    this.batches = [];
    this.enabled = false;
    this.lastSync = { changedEntries: 0, rebuiltBatches: 0, ms: 0 };
  }

  build() {
    if (this.enabled) return this.stats();
    const root = this.model.root;
    if (!root) throw new Error('Batch rendering requires a loaded model.');
    root.updateWorldMatrix(true, true);
    const candidates = [];
    root.traverse((object) => {
      if (!object.isMesh || !object.geometry?.attributes?.position) return;
      const canonicalId = this.model.parentNamed(object)?.userData?.name;
      if (!canonicalId) return;
      const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      candidates.push({ object, canonicalId, center, state: null, batch: null });
    });
    if (!candidates.length) throw new Error('No batchable meshes were found.');

    const bounds = new THREE.Box3();
    for (const entry of candidates) bounds.expandByPoint(entry.center);
    const desired = Math.ceil(candidates.length / this.maxMeshesPerBatch);
    const divisions = Math.max(1, Math.ceil(Math.cbrt(desired)));
    const size = bounds.getSize(new THREE.Vector3());
    const coord = (v, min, span) => span > 0
      ? Math.min(divisions - 1, Math.max(0, Math.floor((v - min) / span * divisions))) : 0;
    const bins = new Map();
    for (const entry of candidates) {
      const key = `${coord(entry.center.x, bounds.min.x, size.x)}:`
        + `${coord(entry.center.y, bounds.min.y, size.y)}:`
        + `${coord(entry.center.z, bounds.min.z, size.z)}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(entry);
    }
    let index = 0;
    for (const key of [...bins.keys()].sort()) {
      const bin = bins.get(key);
      for (let offset = 0; offset < bin.length; offset += this.maxMeshesPerBatch) {
        const batch = { index: index++, spatialCell: key,
          entries: bin.slice(offset, offset + this.maxMeshesPerBatch), meshes: new Map() };
        for (const entry of batch.entries) entry.batch = batch;
        this.batches.push(batch);
      }
    }
    this.entries = candidates;
    this.model.scene.add(this.group);
    this.enabled = true;
    this.sync(true);
    return this.stats();
  }

  _state(entry) {
    if (this.model._inHiddenChain(entry.object)) return this.model.xray ? 'ghost' : 'hidden';
    const material = entry.object.material;
    if (material === this.model.selMeshMat) return 'selected';
    if (material === this.model.hoverMeshMat) return 'hover';
    return 'solid';
  }

  sync(force = false) {
    if (!this.enabled) return this.lastSync;
    const started = performance.now();
    const affected = new Set();
    let changedEntries = 0;
    for (const entry of this.entries) {
      const next = this._state(entry);
      if (force || next !== entry.state) {
        entry.state = next;
        affected.add(entry.batch);
        changedEntries++;
      }
      entry.object.visible = false;
    }
    for (const batch of affected) this._rebuildBatch(batch);
    this.lastSync = { changedEntries, rebuiltBatches: affected.size,
      ms: performance.now() - started };
    return this.lastSync;
  }

  _worldGeometry(entry) {
    const geometry = entry.object.geometry.clone();
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (!geometry.index) {
      const count = geometry.attributes.position.count;
      const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) index[i] = i;
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
    }
    geometry.applyMatrix4(entry.object.matrixWorld);
    return geometry;
  }

  _material(state) {
    if (state === 'selected') return this.model.selMeshMat;
    if (state === 'hover') return this.model.hoverMeshMat;
    if (state === 'ghost') return this.model.ghostMeshMat;
    return this.model.meshMat;
  }

  _rebuildBatch(batch) {
    for (const mesh of batch.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    batch.meshes.clear();
    for (const state of STATES) {
      const entries = batch.entries.filter((entry) => entry.state === state);
      if (!entries.length) continue;
      const parts = [];
      const ranges = [];
      let triangleCursor = 0;
      for (const entry of entries) {
        const geometry = this._worldGeometry(entry);
        const triangleCount = geometry.index.count / 3;
        ranges.push({ canonicalId: entry.canonicalId, sourceMeshUuid: entry.object.uuid,
          triangleStart: triangleCursor, triangleEnd: triangleCursor + triangleCount,
          faceStart: triangleCursor, faceEnd: triangleCursor + triangleCount });
        triangleCursor += triangleCount;
        parts.push(geometry);
      }
      const geometry = mergeGeometries(parts, false);
      for (const part of parts) part.dispose();
      if (!geometry) throw new Error(`Indexed geometry merge failed for batch ${batch.index}/${state}.`);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this._material(state));
      mesh.name = `Batch ${batch.index} ${state}`;
      mesh.userData.batchRendering = { batchIndex: batch.index, spatialCell: batch.spatialCell, state, ranges };
      batch.meshes.set(state, mesh);
      this.group.add(mesh);
    }
  }

  resolveHit(hit) {
    const data = hit?.object?.userData?.batchRendering;
    if (!data || !Number.isInteger(hit.faceIndex) || data.state === 'ghost') return null;
    let low = 0, high = data.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = data.ranges[mid];
      if (hit.faceIndex < range.faceStart) high = mid - 1;
      else if (hit.faceIndex >= range.faceEnd) low = mid + 1;
      else return range.canonicalId;
    }
    return null;
  }

  selectedRenderObjects() {
    const out = [];
    for (const batch of this.batches) {
      const mesh = batch.meshes.get('selected');
      if (mesh) out.push(mesh);
    }
    return out;
  }

  stats() {
    const stateMeshes = { solid: 0, selected: 0, hover: 0, ghost: 0 };
    let triangles = 0, indices = 0, ranges = 0;
    for (const batch of this.batches) for (const [state, mesh] of batch.meshes) {
      stateMeshes[state]++;
      indices += mesh.geometry.index?.count || 0;
      triangles += (mesh.geometry.index?.count || 0) / 3;
      ranges += mesh.userData.batchRendering.ranges.length;
    }
    return { enabled: this.enabled, indexed: this.batches.every((b) =>
      [...b.meshes.values()].every((m) => !!m.geometry.index)),
      maxMeshesPerBatch: this.maxMeshesPerBatch, sourceMeshes: this.entries.length,
      spatialBatches: this.batches.length, renderMeshes: Object.values(stateMeshes).reduce((a, b) => a + b, 0),
      stateMeshes, recordedRanges: ranges, triangles, indices, lastSync: this.lastSync };
  }

  manifest() {
    const objects = {};
    const batches = [];
    for (const batch of this.batches) for (const [state, mesh] of batch.meshes) {
      const data = mesh.userData.batchRendering;
      batches.push({ batchIndex: batch.index, spatialCell: batch.spatialCell, state,
        triangleCount: mesh.geometry.index.count / 3, indexCount: mesh.geometry.index.count,
        ranges: data.ranges });
      for (const range of data.ranges) {
        if (!objects[range.canonicalId]) objects[range.canonicalId] = [];
        objects[range.canonicalId].push({ batchIndex: batch.index, state,
          sourceMeshUuid: range.sourceMeshUuid, triangleStart: range.triangleStart,
          triangleEnd: range.triangleEnd, faceStart: range.faceStart, faceEnd: range.faceEnd });
      }
    }
    return { ...this.stats(), objects, batches };
  }

  dispose() {
    if (!this.enabled) return;
    this.model.scene.remove(this.group);
    for (const batch of this.batches) for (const mesh of batch.meshes.values()) mesh.geometry.dispose();
    for (const entry of this.entries) entry.object.visible = true;
    this.group.clear();
    this.entries.length = 0;
    this.batches.length = 0;
    this.enabled = false;
  }
}
