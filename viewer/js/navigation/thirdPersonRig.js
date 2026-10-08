import * as THREE from 'three';

const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 1.58;
const PIVOT_HEIGHT = 1.20;
const DEFAULT_DISTANCE = 5;
const MIN_DISTANCE = 1;
const MAX_DISTANCE = 20;
const WALL_MARGIN = 0.15;
const EPSILON = 1e-10;
const AVATAR_HEIGHT = 1.70;
const LEG_HEIGHT = 0.775;
const LEG_RADIUS = 0.0755;

/** One closed, gently waisted surface with smooth analytic normals, including the UV seam. */
function roundedTorsoGeometry() {
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const power = 0.58;
  const gradientPower = 2 / power - 1;
  const signedPower = (value, exponent) => Math.sign(value) * Math.pow(Math.abs(value), exponent);
  const normal = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const x = signedPower(positions.getX(i), power);
    const y = signedPower(positions.getY(i), power);
    const z = signedPower(positions.getZ(i), power);
    const waist = 0.91 + 0.09 * y * y;
    const px = x * 0.20 * waist;
    const nx = signedPower(x, gradientPower) / (0.20 * waist);
    normal.set(nx,
      signedPower(y, gradientPower) / 0.285 - nx * px * 0.18 * y / (0.285 * waist),
      signedPower(z, gradientPower) / 0.12).normalize();
    positions.setXYZ(i, px, y * 0.285, z * 0.12);
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The avatar is a separate scene layer. All dimensions are metres. */
export class ThirdPersonRig {
  constructor({ camera, scene, obstacleDistance }) {
    this.camera = camera;
    this.obstacleDistance = obstacleDistance;
    this.active = false;
    this.poseFollower = false;
    this.desiredDistance = DEFAULT_DISTANCE;
    this.effectiveDistance = DEFAULT_DISTANCE;
    this.headingRadians = 0;
    this.walkPhase = 0;
    this.motion = 'idle';
    this.flightElevationRadians = 0;
    this.worldUp = LOCAL_UP.clone();
    this.horizontalForward = new THREE.Vector3(0, 0, -1);
    this.pitchRadians = 0;
    this._upRotation = new THREE.Quaternion();
    this._movedHorizontal = 0;
    this._movedVertical = 0;
    this._projectionBeforeStart = null;

    this.group = new THREE.Group();
    this.group.name = 'ThirdPersonAvatar';
    this.group.userData.nonSelectable = true;
    this.group.userData.navigationHelper = true;
    this.group.userData.heightMeters = AVATAR_HEIGHT;
    this.group.visible = false;
    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = 'SignAvatarBody';
    this.helmetGroup = new THREE.Group();
    this.helmetGroup.name = 'SafetyHelmet';
    this.poseGroup = new THREE.Group();
    this.poseGroup.name = 'AvatarPose';
    this.poseGroup.position.y = PIVOT_HEIGHT;
    this.poseGroup.add(this.bodyGroup, this.helmetGroup);
    this.group.add(this.poseGroup);

    this._materials = [
      new THREE.MeshStandardMaterial({ color: 0xf0f1f3, roughness: 0.38, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: 0xf7f7f7, roughness: 0.32, metalness: 0 }),
    ];
    this._buildAvatar();
    this.group.traverse((object) => {
      object.userData.nonSelectable = true;
      object.userData.navigationHelper = true;
      if (object.isMesh) object.raycast = () => {};
    });
    scene.add(this.group);
  }

  _mesh(parent, name, geometry, position, material = this._materials[0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }

  _buildAvatar() {
    // Pictogram proportions: detached head, a single torso, and four unbroken limbs.
    // Standing height includes the helmet ridge; the feet rest exactly at zero.
    const head = this._mesh(this.bodyGroup, 'Head', new THREE.SphereGeometry(1, 48, 32), [0, 1.524, 0]);
    head.scale.set(0.126, 0.133, 0.122);
    this._mesh(this.bodyGroup, 'Torso', roundedTorsoGeometry(), [0, 1.085, 0]);

    const armHeight = 0.545;
    const armGeometry = new THREE.CapsuleGeometry(0.059, armHeight - 2 * 0.059, 12, 32);
    armGeometry.scale(1, 1, 0.90);
    armGeometry.translate(0, -armHeight / 2, 0);
    const legGeometry = new THREE.CapsuleGeometry(LEG_RADIUS, LEG_HEIGHT - 2 * LEG_RADIUS, 12, 32);
    legGeometry.translate(0, -LEG_HEIGHT / 2, 0);

    this.arms = [];
    this.legs = [];
    for (const side of [-1, 1]) {
      const suffix = side < 0 ? 'Left' : 'Right';
      const shoulder = new THREE.Group();
      shoulder.name = suffix + 'Shoulder';
      shoulder.position.set(side * 0.26, 1.31, 0);
      this.bodyGroup.add(shoulder);
      this._mesh(shoulder, suffix + 'Arm', armGeometry, [0, 0, 0]);
      this.arms.push({ shoulder, side });

      const hip = new THREE.Group();
      hip.name = suffix + 'Hip';
      hip.position.set(side * 0.101, LEG_HEIGHT, 0);
      this.bodyGroup.add(hip);
      this._mesh(hip, suffix + 'Leg', legGeometry, [0, 0, 0]);
      this.legs.push({ hip, side });
    }

    // Smooth hard-hat shell, one rounded oval brim, and an embedded crown ridge.
    const domeBase = AVATAR_HEIGHT - 0.009 - 0.14;
    const dome = this._mesh(this.helmetGroup, 'HelmetDome',
      new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      [0, domeBase, 0], this._materials[1]);
    dome.scale.set(0.145, 0.14, 0.132);
    const brim = this._mesh(this.helmetGroup, 'HelmetBrim',
      new THREE.SphereGeometry(1, 48, 20), [0, domeBase + 0.002, 0.016], this._materials[1]);
    brim.scale.set(0.171, 0.012, 0.166);
    const ridgePoints = [];
    for (let i = 0; i <= 16; i++) {
      const angle = i * Math.PI / 16;
      ridgePoints.push(new THREE.Vector3(0, domeBase + 0.14 * Math.sin(angle), 0.132 * Math.cos(angle)));
    }
    this._mesh(this.helmetGroup, 'HelmetRidge',
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ridgePoints), 48, 0.009, 12, false),
      [0, 0, 0], this._materials[1]);
    this._applyPose();
  }

  _setFrame(frame) {
    if (!frame) return;
    if (frame.worldUp?.lengthSq() > EPSILON) this.worldUp.copy(frame.worldUp).normalize();
    if (frame.horizontalForward?.lengthSq() > EPSILON) {
      this.horizontalForward.copy(frame.horizontalForward)
        .addScaledVector(this.worldUp, -frame.horizontalForward.dot(this.worldUp)).normalize();
    }
    if (Number.isFinite(frame.pitchRadians)) this.pitchRadians = frame.pitchRadians;
    this._upRotation.setFromUnitVectors(LOCAL_UP, this.worldUp);
  }

  _forward() {
    return this.horizontalForward.clone().multiplyScalar(Math.cos(this.pitchRadians))
      .addScaledVector(this.worldUp, Math.sin(this.pitchRadians)).normalize();
  }

  _face(direction) {
    const local = direction.clone().applyQuaternion(this._upRotation.clone().invert());
    if (local.x * local.x + local.z * local.z > EPSILON) {
      this.headingRadians = Math.atan2(local.x, local.z);
    }
    this._applyHeading();
  }

  _applyHeading() {
    this.group.quaternion.copy(this._upRotation).multiply(
      new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, this.headingRadians));
  }

  start(frame) {
    if (this.active) return;
    this._projectionBeforeStart = { fov: this.camera.fov, near: this.camera.near };
    this._setFrame(frame);
    this.group.position.copy(this.camera.position).addScaledVector(this.worldUp, -EYE_HEIGHT);
    this._face(this.horizontalForward);
    this.desiredDistance = DEFAULT_DISTANCE;
    this.effectiveDistance = DEFAULT_DISTANCE;
    this.walkPhase = 0;
    this.motion = 'idle';
    this.flightElevationRadians = 0;
    this._movedHorizontal = this._movedVertical = 0;
    this.active = true;
    this.group.visible = true;
    this.camera.fov = 50;
    this.camera.near = Math.min(this.camera.near, 0.03);
    this.camera.updateProjectionMatrix();
    this._applyPose();
    if (!this.poseFollower) this._updateCamera();
  }

  stop({ toGame = false } = {}) {
    if (!this.active) return;
    if (toGame) this.camera.position.copy(this.group.position).addScaledVector(this.worldUp, EYE_HEIGHT);
    this.active = false;
    this.group.visible = false;
    this.resetPose();
    if (this._projectionBeforeStart) {
      this.camera.fov = this._projectionBeforeStart.fov;
      this.camera.near = this._projectionBeforeStart.near;
      this.camera.updateProjectionMatrix();
      this._projectionBeforeStart = null;
    }
  }

  /** Preserve an external camera jump by moving the rig to its new look direction. */
  rebase(frame) {
    if (!this.active) return;
    this._setFrame(frame);
    this.group.position.copy(this.camera.position).addScaledVector(this._forward(), this.desiredDistance)
      .addScaledVector(this.worldUp, -PIVOT_HEIGHT);
    this.effectiveDistance = this.desiredDistance;
    this._movedHorizontal = this._movedVertical = 0;
    this.motion = 'idle';
    this.flightElevationRadians = 0;
    this._applyHeading();
    this._applyPose();
    this.camera.near = Math.min(this.camera.near, 0.03);
    this.camera.updateProjectionMatrix();
  }

  move(direction, distance) {
    if (!this.active || this.poseFollower || !Number.isFinite(distance) || !direction) return;
    const displacement = direction.clone().multiplyScalar(distance);
    if (displacement.lengthSq() <= EPSILON) return;
    this.group.position.add(displacement);
    const vertical = displacement.dot(this.worldUp);
    const horizontal = displacement.clone().addScaledVector(this.worldUp, -vertical);
    this._movedHorizontal += horizontal.length();
    this._movedVertical += vertical;
    if (horizontal.lengthSq() > EPSILON) this._face(horizontal);
  }

  update(frame, elapsed, axes = {}, sprinting = false) {
    if (!this.active) return false;
    if (this.poseFollower) return false;
    this._setFrame(frame);
    this._applyHeading();
    // Flight is the double-tap forward sprint pose, never the vertical navigation pose.
    this.motion = this._movedHorizontal > EPSILON
      ? (sprinting && axes.forward > 0 ? 'flying' : 'walking') : 'idle';
    // Use signed travel along world-up, so ascent and descent produce opposite tilts.
    this.flightElevationRadians = this.motion === 'flying'
      ? Math.atan2(this._movedVertical, this._movedHorizontal) : 0;
    if (this.motion === 'walking') {
      this.walkPhase = (this.walkPhase + this._movedHorizontal * Math.PI * 2 / 1.35) % (Math.PI * 2);
    }
    this._applyPose();
    this._movedHorizontal = this._movedVertical = 0;
    return this._updateCamera();
  }

  _applyPose() {
    const flying = this.motion === 'flying';
    // Lean around the follow-camera pivot, keeping body and helmet together.
    this.poseGroup.rotation.x = flying ? Math.PI / 2 - this.flightElevationRadians : 0;
    const swing = this.motion === 'walking' ? Math.sin(this.walkPhase) * 0.38 : 0;
    for (const { hip, side } of this.legs) {
      hip.rotation.x = side * swing;
    }
    for (const { shoulder, side } of this.arms) {
      shoulder.rotation.x = flying ? Math.PI : -side * swing * 0.75;
      shoulder.rotation.z = side * (flying ? 0.24 : 0.055);
    }
    // Lower the silhouette as its legs spread so the rounded feet stay on the foot plane.
    const footLift = (LEG_HEIGHT - LEG_RADIUS) * (1 - Math.cos(swing));
    this.bodyGroup.position.y = this.helmetGroup.position.y = -PIVOT_HEIGHT - footLift;
  }

  /** Cancelling input must also cancel the sprint silhouette, including while paused. */
  resetPose() {
    this._movedHorizontal = this._movedVertical = 0;
    this.motion = 'idle';
    this.flightElevationRadians = 0;
    this._applyPose();
  }

  _updateCamera() {
    const pivot = this.pivot();
    const forward = this._forward();
    const desiredPosition = pivot.clone().addScaledVector(forward, -this.desiredDistance);
    const obstacle = this.obstacleDistance?.(pivot, desiredPosition);
    this.effectiveDistance = Number.isFinite(obstacle)
      ? Math.min(this.desiredDistance, Math.max(0, obstacle - WALL_MARGIN))
      : this.desiredDistance;
    const nextPosition = pivot.clone().addScaledVector(forward, -this.effectiveDistance);
    const changed = this.camera.position.distanceToSquared(nextPosition) > EPSILON;
    if (changed) this.camera.position.copy(nextPosition);
    this.camera.up.copy(this.worldUp);
    // lookAt is deterministic; an idle frame cannot accumulate camera drift.
    const previousQuaternion = this.camera.quaternion.clone();
    this.camera.lookAt(nextPosition.clone().add(forward));
    return changed || 1 - Math.abs(previousQuaternion.dot(this.camera.quaternion)) > EPSILON;
  }

  zoom(notches) {
    if (!Number.isFinite(notches) || Math.abs(notches) <= EPSILON) return false;
    const next = THREE.MathUtils.clamp(this.desiredDistance * Math.pow(0.9, notches), MIN_DISTANCE, MAX_DISTANCE);
    const changed = Math.abs(next - this.desiredDistance) > EPSILON;
    this.desiredDistance = next;
    return changed;
  }

  pivot() {
    return this.group.position.clone().addScaledVector(this.worldUp, PIVOT_HEIGHT);
  }

  state(frame) {
    const worldUp = frame?.worldUp || this.worldUp;
    const horizontalForward = frame?.horizontalForward || this.horizontalForward;
    return {
      footPosition: this.group.position.toArray(),
      headingRadians: this.headingRadians,
      desiredDistance: this.desiredDistance,
      effectiveDistance: this.effectiveDistance,
      walkPhase: this.walkPhase,
      motion: this.motion,
      flightElevationRadians: this.flightElevationRadians,
      worldUp: worldUp.toArray(),
      horizontalForward: horizontalForward.toArray(),
      pitchRadians: Number.isFinite(frame?.pitchRadians) ? frame.pitchRadians : this.pitchRadians,
    };
  }

  /** Split view supplies the actual camera separately; only avatar state is copied here. */
  applyState(state) {
    if (!state) return;
    if (state.worldUp?.length === 3 && state.worldUp.every(Number.isFinite)) {
      this.worldUp.fromArray(state.worldUp).normalize();
      if (this.worldUp.lengthSq() <= EPSILON) this.worldUp.copy(LOCAL_UP);
    }
    if (state.horizontalForward?.length === 3 && state.horizontalForward.every(Number.isFinite)) {
      this.horizontalForward.fromArray(state.horizontalForward).normalize();
    }
    if (state.footPosition?.length === 3 && state.footPosition.every(Number.isFinite)) {
      this.group.position.fromArray(state.footPosition);
    }
    for (const property of ['headingRadians', 'walkPhase', 'pitchRadians']) {
      if (Number.isFinite(state[property])) this[property] = state[property];
    }
    if (Number.isFinite(state.desiredDistance)) {
      this.desiredDistance = THREE.MathUtils.clamp(state.desiredDistance, MIN_DISTANCE, MAX_DISTANCE);
    }
    if (Number.isFinite(state.effectiveDistance)) {
      this.effectiveDistance = THREE.MathUtils.clamp(state.effectiveDistance, 0, this.desiredDistance);
    }
    if (['idle', 'walking', 'flying'].includes(state.motion)) {
      this.motion = state.motion;
    }
    this.flightElevationRadians = this.motion === 'flying' && Number.isFinite(state.flightElevationRadians)
      ? THREE.MathUtils.clamp(state.flightElevationRadians, -Math.PI / 2, Math.PI / 2) : 0;
    this._upRotation.setFromUnitVectors(LOCAL_UP, this.worldUp);
    this._movedHorizontal = this._movedVertical = 0;
    this._applyHeading();
    this._applyPose();
    this.group.visible = this.active;
  }

  dispose() {
    this.stop();
    this.group.removeFromParent();
    const geometries = new Set();
    this.group.traverse((object) => { if (object.geometry) geometries.add(object.geometry); });
    for (const geometry of geometries) geometry.dispose();
    for (const material of this._materials) material.dispose();
  }
}
