import * as THREE from 'three';

// Classic 3/4 sim camera: a fixed orthographic view looking down a diagonal. Orthographic rather
// than perspective is what makes it read as a city *sim* — parallel lines stay parallel, so
// blocks at the far edge look the same size as blocks under the cursor.

const VIEW_DIR = new THREE.Vector3(1, 0.92, 1).normalize();
const DISTANCE = 400;

export function createCityCamera(aspect, { zoom = 46, target = [0, 0] } = {}) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1400);
  const state = {
    zoom,                       // half-height of the view frustum, in world units
    target: new THREE.Vector3(target[0], 0, target[1]),
  };

  function apply(aspectRatio) {
    const halfH = state.zoom;
    const halfW = halfH * aspectRatio;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();

    camera.position.copy(state.target).addScaledVector(VIEW_DIR, DISTANCE);
    camera.lookAt(state.target);
  }

  apply(aspect);

  return {
    camera,
    state,
    resize: (aspectRatio) => apply(aspectRatio),
    update: (aspectRatio) => apply(aspectRatio),
  };
}

/** Pan with WASD/arrows, zoom on the wheel. Pans along screen axes, not world axes. */
export function attachCameraControls(controller, domElement, getAspect) {
  const keys = new Set();
  const PAN_SPEED = 60;
  const MIN_ZOOM = 14;
  const MAX_ZOOM = 150;

  const onKey = (down) => (event) => {
    const code = event.code;
    if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(code)) return;
    down ? keys.add(code) : keys.delete(code);
    if (code.startsWith('Arrow')) event.preventDefault();
  };

  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => keys.clear());

  domElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0012);
    controller.state.zoom = THREE.MathUtils.clamp(controller.state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    controller.update(getAspect());
  }, { passive: false });

  // Drag to pan, in the same screen-relative frame as the keys.
  let dragging = null;
  domElement.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY };
    domElement.setPointerCapture(event.pointerId);
  });
  domElement.addEventListener('pointerup', () => { dragging = null; });
  domElement.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY };

    const scale = (controller.state.zoom * 2) / domElement.clientHeight;
    panBy(-dx * scale, -dy * scale);
  });

  // Screen right is world (+X, -Z) for this view direction; screen up is (-X, -Z).
  const RIGHT = new THREE.Vector3(1, 0, -1).normalize();
  const UP = new THREE.Vector3(-1, 0, -1).normalize();

  function panBy(right, up) {
    controller.state.target.addScaledVector(RIGHT, right);
    controller.state.target.addScaledVector(UP, up);
  }

  return function updateControls(dt) {
    let right = 0;
    let up = 0;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) up += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) up -= 1;

    if (right || up) {
      const speed = PAN_SPEED * dt * (controller.state.zoom / 46);
      panBy(right * speed, up * speed);
    }
    controller.update(getAspect());
  };
}
