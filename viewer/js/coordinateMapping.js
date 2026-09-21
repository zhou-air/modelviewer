import * as THREE from 'three';

/**
 * Project coordinate mapping used by the RVM -> GLB converter:
 * PDMS +X (East) -> Three.js +X
 * PDMS +Y (North) -> Three.js -Z
 * PDMS +Z (Up) -> Three.js +Y
 *
 * Keep engineering features on these vectors instead of treating glTF XYZ as
 * PDMS XYZ. Translation by rvmparser-origin does not affect directions.
 */
export const ENGINEERING_AXES = Object.freeze({
  E: new THREE.Vector3(1, 0, 0),
  N: new THREE.Vector3(0, 0, -1),
  U: new THREE.Vector3(0, 1, 0),
});

export const GLB_AXES = Object.freeze({
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
});
