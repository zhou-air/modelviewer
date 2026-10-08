import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';

export const loadCancelled = () => new DOMException('模型加载已取消', 'AbortError');

/** A late loader response still owns resources, even when it never enters a scene. */
export function disposeGLTF(gltf) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  for (const root of new Set(gltf.scenes || [gltf.scene])) root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

/** GLTFLoader does not expose abort; reject promptly and dispose its eventual result. */
export function loadGLTF(url, { onProgress, signal, isCurrent = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const current = () => !signal?.aborted && isCurrent();
    const abort = () => reject(loadCancelled());
    if (!current()) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const clean = () => signal?.removeEventListener('abort', abort);
    new GLTFLoader().load(url, (gltf) => {
      clean();
      if (!current()) { disposeGLTF(gltf); abort(); return; }
      resolve(gltf);
    }, (event) => { if (current()) onProgress?.(event); }, (error) => {
      clean();
      reject(current() ? new Error(error?.message || 'GLB 加载失败') : loadCancelled());
    });
  });
}
