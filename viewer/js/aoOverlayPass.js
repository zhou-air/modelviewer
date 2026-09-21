import * as THREE from 'three';
import { Pass } from '../vendor/jsm/postprocessing/Pass.js';

/** Draw existing engineering helpers after AO, into the original scene color/depth target.
 * The small scene holds non-owning references for this draw only. No meshes/materials
 * are cloned, no model traversal and no changes to the objects' parent/identity.
 */
export class AOOverlayPass extends Pass {
  constructor(model) {
    super(); this.model = model; this.needsSwap = false;
    this.scene = new THREE.Scene(); this.scene.matrixWorldAutoUpdate = false;
    this.hidden = [];
  }
  hideForBase() {
    this.hidden.length = 0;
    for (const object of [this.model.floorPlanGroup, this.model.measurement?.group]) {
      if (object?.visible) { this.hidden.push(object); object.visible = false; }
    }
  }
  restoreBase() { for (const object of this.hidden) object.visible = true; this.hidden.length = 0; }
  render(renderer, writeBuffer, readBuffer) {
    const previousAutoClear = renderer.autoClear;
    const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
    for (const object of [this.model.floorPlanGroup, this.model.measurement?.group]) {
      if (object?.visible) this.scene.children.push(object);
    }
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(readBuffer);
      if (this.scene.children.length) renderer.render(this.scene, this.model.camera);
      this.model.sceneDrawCalls += renderer.info.render.calls - calls;
      this.model.sceneTriangles += renderer.info.render.triangles - triangles;
    } finally {
      this.scene.children.length = 0; renderer.autoClear = previousAutoClear;
    }
  }
}
