import * as THREE from 'three';

/** Scene siblings, never children of the model or inputs to its bounding box. */
export class LightingController {
  constructor(scene, settings = {}) {
    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0xc4ccd4, 1.8);
    this.key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.key.castShadow = false;
    this.offset = new THREE.Vector3(-0.45, 0.65, 1);
    scene.add(this.hemisphere, this.key, this.key.target);
    this.apply(settings);
  }
  apply({ lightingEnabled = true, lightingIntensity = 1 } = {}) {
    this.lightingEnabled = lightingEnabled;
    this.lightingIntensity = lightingIntensity;
    // Disabled enhancement retains neutral illumination so PBR objects stay readable.
    this.hemisphere.groundColor.set(lightingEnabled ? 0xc4ccd4 : 0xffffff);
    this.hemisphere.intensity = lightingEnabled ? 1.8 * lightingIntensity : 2.5;
    this.key.intensity = lightingEnabled ? 2.1 * lightingIntensity : 0;
  }
  update(camera) {
    this.key.target.position.copy(camera.position);
    this.key.position.copy(this.offset).applyQuaternion(camera.quaternion).add(camera.position);
  }
  dispose() {
    this.hemisphere.removeFromParent(); this.key.removeFromParent(); this.key.target.removeFromParent();
    this.hemisphere.dispose(); this.key.dispose();
  }
}
