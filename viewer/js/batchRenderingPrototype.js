import * as THREE from 'three';
import { mergeGeometries } from '../vendor/jsm/utils/BufferGeometryUtils.js';

/**
 * Opt-in geometry batching experiment. It leaves the source GLB hierarchy and
 * canonical/metadata maps intact, and only substitutes the rendered Mesh set.
 */
export class BatchRenderingPrototype {
  constructor(model, { maxMeshesPerBatch = 64 } = {}) {
    this.model = model;
    this.maxMeshesPerBatch = maxMeshesPerBatch;
    this.group = new THREE.Group();
    this.group.name = '__BATCH_RENDERING_PROTOTYPE__';
    this.batches = [];
    this.originalMeshes = [];
    this.enabled = false;
  }

  build() {
    if (this.enabled) return this.stats();
    const root = this.model.root;
    if (!root) throw new Error('Batch prototype requires a loaded model.');
    root.updateWorldMatrix(true, true);

    const entries = [];
    root.traverse((object) => {
      if (!object.isMesh || !object.geometry?.attributes?.position) return;
      const named = this.model.parentNamed(object);
      const canonicalId = named?.userData?.name || null;
      if (!canonicalId) return;
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      entries.push({ object, canonicalId, center });
    });
    if (!entries.length) throw new Error('No batchable meshes were found.');

    const bounds = new THREE.Box3();
    for (const entry of entries) bounds.expandByPoint(entry.center);
    const desiredBatches = Math.ceil(entries.length / this.maxMeshesPerBatch);
    const divisions = Math.max(1, Math.ceil(Math.cbrt(desiredBatches)));
    const size = bounds.getSize(new THREE.Vector3());
    const bins = new Map();
    const axis = (v, min, span) => span > 0
      ? Math.min(divisions - 1, Math.max(0, Math.floor((v - min) / span * divisions)))
      : 0;
    for (const entry of entries) {
      const x = axis(entry.center.x, bounds.min.x, size.x);
      const y = axis(entry.center.y, bounds.min.y, size.y);
      const z = axis(entry.center.z, bounds.min.z, size.z);
      const key = `${x}:${y}:${z}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(entry);
    }

    let batchIndex = 0;
    for (const key of [...bins.keys()].sort()) {
      const bin = bins.get(key);
      for (let offset = 0; offset < bin.length; offset += this.maxMeshesPerBatch) {
        const chunk = bin.slice(offset, offset + this.maxMeshesPerBatch);
        const batch = this._createBatch(chunk, batchIndex++, key);
        this.group.add(batch);
        this.batches.push(batch);
      }
    }

    for (const entry of entries) {
      entry.object.visible = false;
      this.originalMeshes.push(entry.object);
    }
    this.model.scene.add(this.group);
    this.enabled = true;
    return this.stats();
  }

  _createBatch(entries, batchIndex, spatialCell) {
    const geometries = [];
    const ranges = [];
    let triangleCursor = 0;
    for (const entry of entries) {
      let geometry = entry.object.geometry.clone();
      if (geometry.index) geometry = geometry.toNonIndexed();
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
      }
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.applyMatrix4(entry.object.matrixWorld);
      const triangleCount = geometry.attributes.position.count / 3;
      ranges.push({
        canonicalId: entry.canonicalId,
        sourceMeshUuid: entry.object.uuid,
        triangleStart: triangleCursor,
        triangleEnd: triangleCursor + triangleCount,
        faceStart: triangleCursor,
        faceEnd: triangleCursor + triangleCount,
      });
      triangleCursor += triangleCount;
      geometries.push(geometry);
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) throw new Error(`Geometry merge failed for batch ${batchIndex}.`);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, this.model.meshMat);
    mesh.name = `Batch ${batchIndex}`;
    mesh.userData.batchPrototype = { batchIndex, spatialCell, ranges };
    return mesh;
  }

  resolveHit(hit) {
    if (!hit?.object?.userData?.batchPrototype || !Number.isInteger(hit.faceIndex)) return null;
    const ranges = hit.object.userData.batchPrototype.ranges;
    let low = 0, high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = ranges[mid];
      if (hit.faceIndex < range.faceStart) high = mid - 1;
      else if (hit.faceIndex >= range.faceEnd) low = mid + 1;
      else return range.canonicalId;
    }
    return null;
  }

  stats() {
    const ranges = this.batches.reduce((n, b) => n + b.userData.batchPrototype.ranges.length, 0);
    const canonicalIds = new Set();
    for (const batch of this.batches) {
      for (const range of batch.userData.batchPrototype.ranges) canonicalIds.add(range.canonicalId);
    }
    const triangles = this.batches.reduce((n, b) => n + b.geometry.attributes.position.count / 3, 0);
    return {
      enabled: this.enabled,
      maxMeshesPerBatch: this.maxMeshesPerBatch,
      originalMeshes: this.originalMeshes.length,
      batches: this.batches.length,
      recordedRanges: ranges,
      recordedCanonicalIds: canonicalIds.size,
      triangles,
    };
  }

  manifest() {
    const objects = {};
    for (const batch of this.batches) {
      const batchIndex = batch.userData.batchPrototype.batchIndex;
      for (const range of batch.userData.batchPrototype.ranges) {
        if (!objects[range.canonicalId]) objects[range.canonicalId] = [];
        objects[range.canonicalId].push({ batchIndex, sourceMeshUuid: range.sourceMeshUuid,
          triangleStart: range.triangleStart, triangleEnd: range.triangleEnd,
          faceStart: range.faceStart, faceEnd: range.faceEnd });
      }
    }
    return {
      ...this.stats(),
      objects,
      batches: this.batches.map((batch) => ({
        batchIndex: batch.userData.batchPrototype.batchIndex,
        spatialCell: batch.userData.batchPrototype.spatialCell,
        triangleCount: batch.geometry.attributes.position.count / 3,
        ranges: batch.userData.batchPrototype.ranges,
      })),
    };
  }

  dispose() {
    if (!this.group) return;
    this.model.scene.remove(this.group);
    for (const batch of this.batches) batch.geometry.dispose();
    for (const mesh of this.originalMeshes) mesh.visible = true;
    this.group.clear();
    this.batches.length = 0;
    this.originalMeshes.length = 0;
    this.enabled = false;
  }
}
