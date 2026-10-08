import * as THREE from 'three';

/** Camera-only obstacle probe. It never changes the model or the picking ray. */
export class CameraObstacleProbe {
  constructor(model) {
    this.model = model;
    this.raycaster = new THREE.Raycaster();
    this.bounds = new WeakMap();
    this.revision = 0;
    this.tests = 0;
    this._root = null;
    this._meshes = [];
    this._lastKey = null;
    this._lastDistance = Infinity;
  }

  invalidate() {
    this.revision++;
    this._root = null;
    this._meshes = [];
    this._lastKey = null;
  }

  _source() {
    const m = this.model;
    const isA = m.compare?.primary === 'A';
    return { root: isA ? m.compare.root : m.root,
      batch: isA ? m.compare.batch : m.batchRendering, isA };
  }

  _box(mesh) {
    mesh.updateWorldMatrix(true, false);
    const matrix = mesh.matrixWorld.elements;
    let cached = this.bounds.get(mesh);
    if (!cached || cached.geometry !== mesh.geometry || matrix.some((v, i) => v !== cached.matrix[i])) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      cached = { geometry: mesh.geometry, matrix: [...matrix],
        box: mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld) };
      this.bounds.set(mesh, cached);
    }
    return cached.box;
  }

  distance(pivot, desiredPosition) {
    const { root, batch, isA } = this._source();
    if (!root || !root.visible || (batch?.enabled && !batch.group.visible)) return Infinity;
    let meshes;
    let sourceKey;
    if (batch?.enabled) {
      // Source meshes have visible=false after batching: inspect rendered batches.
      meshes = batch.group.children.filter(o => o.isMesh && o.visible
        && o.userData.batchRendering?.state !== 'ghost');
      sourceKey = meshes.map(o => `${o.id}:${o.geometry.id}`).join(',');
    } else {
      if (this._root !== root) {
        this._root = root;
        this._meshes = [];
        root.traverse(o => { if (o.isMesh) this._meshes.push(o); });
      }
      meshes = this._meshes.filter(o => this.model._visibleInScene(o)
        && (isA || !this.model._inHiddenChain(o)));
      sourceKey = meshes.map(o => `${o.id}:${o.geometry.id}`).join(',');
    }
    const key = `${this.revision}:${root.id}:${sourceKey}:${pivot.toArray()}:${desiredPosition.toArray()}`;
    if (key === this._lastKey) return this._lastDistance;
    const direction = desiredPosition.clone().sub(pivot);
    const length = direction.length();
    if (length < 1e-8) return Infinity;
    direction.divideScalar(length);
    this.raycaster.near = 0;
    this.raycaster.far = length;
    this.raycaster.set(pivot, direction);
    const point = new THREE.Vector3();
    const candidates = meshes.filter(mesh => {
      const box = this._box(mesh);
      const hit = this.raycaster.ray.intersectBox(box, point);
      return hit && (box.containsPoint(pivot) || pivot.distanceTo(point) <= length);
    });
    let nearest = Infinity;
    this.tests++;
    for (const hit of this.raycaster.intersectObjects(candidates, false)) {
      nearest = Math.min(nearest, hit.distance);
    }
    // A reverse ray also catches back faces without changing shared materials.
    this.raycaster.set(desiredPosition, direction.clone().negate());
    for (const hit of this.raycaster.intersectObjects(candidates, false)) {
      nearest = Math.min(nearest, Math.max(0, length - hit.distance));
    }
    this._lastKey = key;
    this._lastDistance = nearest;
    return nearest;
  }

  dispose() {
    this.invalidate();
    this._meshes = [];
    this.bounds = new WeakMap();
  }
}
