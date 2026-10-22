// Slide 2's gag: a click rains Dr Pepper cans down the screen and they pile up on the bottom edge.
// A transparent three.js canvas over the slide, with cannon-es doing the tumbling. Loaded on the
// first click (talk.js imports this lazily), and only ever on the talk page.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// A real 12oz can is 66mm across and 122mm tall; scaled so one is ~75px tall on a 780px window.
const RADIUS = 0.5;
const HEIGHT = 1.85;
const PER_CLICK = 14;
const MAX_CANS = 120;
// The pile lives in a shallow box in front of the slide, so it stacks rather than spreading back
// into the screen where perspective would shrink it to nothing.
const DEPTH = 1.6;
const FOV = 35;
const CAM_Z = 30;

/**
 * A can, not a tube: the foot narrows to a ring under a domed base, the shoulder tapers in to a
 * rolled rim over a recessed lid, and a ring-pull sits on top. Built centred on its own origin
 * with Y up, the way cannon-es's Cylinder is, so the physics' plain cylinder still fits it.
 * Groups: 0 the label, 1 the aluminium.
 */
function canGeometry() {
  const h = HEIGHT / 2;
  const R = RADIUS;
  const BODY_LO = -h + 0.2;
  const BODY_HI = h - 0.3;
  const v = (x, y) => new THREE.Vector2(x, y);
  // Lathe profiles run from the axis outward along the bottom, and from the body inward along the
  // top, so both wind with their faces out.
  const bottom = new THREE.LatheGeometry([
    v(0, -h + 0.09), v(0.22, -h + 0.06), v(0.33, -h + 0.01), v(0.37, -h), v(0.4, -h + 0.01),
    v(0.45, -h + 0.08), v(0.49, -h + 0.16), v(R, BODY_LO),
  ], 32);
  const top = new THREE.LatheGeometry([
    v(R, BODY_HI), v(0.49, BODY_HI + 0.08), v(0.45, h - 0.12), v(0.42, h - 0.04),
    v(0.425, h), v(0.4, h + 0.005), v(0.385, h - 0.04), v(0, h - 0.04),
  ], 32);
  // The ring-pull: a flat tab lying on the lid, its rivet at the centre and its finger loop
  // reaching toward the rim.
  const tab = new THREE.TorusGeometry(0.075, 0.022, 6, 20);
  tab.rotateX(Math.PI / 2);
  tab.scale(1, 1, 1.5);
  tab.translate(0, h - 0.025, 0.12);
  const rivet = new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10);
  rivet.translate(0, h - 0.025, 0);
  for (const g of [bottom, top, tab, rivet]) g.deleteAttribute('uv');
  const metal = mergeGeometries([bottom, top, tab, rivet].map((g) => g.toNonIndexed()));
  // The label keeps its UVs for the texture; the metal needs none, so give it zeros to merge.
  const label = new THREE.CylinderGeometry(R, R, BODY_HI - BODY_LO, 32, 1, true).toNonIndexed();
  label.translate(0, (BODY_HI + BODY_LO) / 2, 0);
  metal.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(metal.attributes.position.count * 2), 2));
  return mergeGeometries([label, metal], true);
}

function labelTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6b0f1f';
  g.fillRect(0, 0, 512, 256);
  // A darker band top and bottom, the way the real can fades to the rims.
  g.fillStyle = '#4a0915';
  g.fillRect(0, 0, 512, 26);
  g.fillRect(0, 230, 512, 26);
  g.fillStyle = '#fff';
  g.font = 'italic 700 64px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Twice round the can, so the name faces the camera whichever way it lands.
  g.fillText('Dr Pepper', 128, 128);
  g.fillText('Dr Pepper', 384, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createCans() {
  const canvas = document.createElement('canvas');
  canvas.id = 'cans';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 100);
  camera.position.set(0, 0, CAM_Z);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a70, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-6, 10, 12);
  scene.add(sun);

  const geometry = canGeometry();
  const materials = [
    new THREE.MeshStandardMaterial({ map: labelTexture(), metalness: 0.35, roughness: 0.35 }),
    // Double-sided: the lid sits recessed inside the rim, and a lathe's inner face shows there.
    new THREE.MeshStandardMaterial({ color: 0xd2d6db, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide }),
  ];

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0) });
  world.allowSleep = true;
  world.broadphase = new CANNON.SAPBroadphase(world);
  // Dead and grippy: the first cut bounced at 0.25 with almost no damping, and the cans pinged
  // off each other and the box walls like a plinko board instead of landing in a heap.
  world.defaultContactMaterial.friction = 0.7;
  world.defaultContactMaterial.restitution = 0.02;
  world.solver.iterations = 20;
  const shape = new CANNON.Cylinder(RADIUS, RADIUS, HEIGHT, 12);

  // Floor at the bottom edge of the screen, walls at the sides and front and back. Rebuilt on a
  // resize, since the visible width at the pile's depth follows the window's aspect.
  const walls = [];
  let halfW = 10;
  let halfH = 10;
  function plane(pos, axis, angle) {
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    b.position.set(...pos);
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(...axis), angle);
    world.addBody(b);
    walls.push(b);
  }
  function layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    halfH = CAM_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    halfW = halfH * camera.aspect;
    for (const b of walls) world.removeBody(b);
    walls.length = 0;
    plane([0, -halfH, 0], [1, 0, 0], -Math.PI / 2);
    plane([-halfW, 0, 0], [0, 1, 0], Math.PI / 2);
    plane([halfW, 0, 0], [0, 1, 0], -Math.PI / 2);
    plane([0, 0, -DEPTH], [0, 1, 0], 0);
    plane([0, 0, DEPTH], [0, 1, 0], Math.PI);
    for (const c of cans) c.body.wakeUp();
  }

  const cans = [];
  const pending = [];
  function spawn() {
    if (cans.length >= MAX_CANS) {
      const old = cans.shift();
      world.removeBody(old.body);
      scene.remove(old.mesh);
    }
    const body = new CANNON.Body({
      mass: 1, shape, linearDamping: 0.05, angularDamping: 0.45,
      sleepSpeedLimit: 0.6, sleepTimeLimit: 0.4,
    });
    body.position.set(
      (Math.random() * 2 - 1) * (halfW - 1.5),
      halfH + 2 + Math.random() * 6,
      (Math.random() * 2 - 1) * (DEPTH - 0.6));
    body.quaternion.setFromEuler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    body.angularVelocity.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    body.velocity.set((Math.random() - 0.5) * 1.5, -4 - Math.random() * 4, 0);
    world.addBody(body);
    const mesh = new THREE.Mesh(geometry, materials);
    scene.add(mesh);
    cans.push({ body, mesh });
  }

  let raf = 0;
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000 || 1 / 60, 1 / 20);
    last = now;
    world.step(1 / 60, dt, 4);
    for (const { body, mesh } of cans) {
      mesh.position.copy(body.position);
      mesh.quaternion.copy(body.quaternion);
    }
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', layout);
  layout();

  return {
    /** A burst of cans, staggered so they arrive as a stream rather than one slab. */
    drop() {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
      canvas.classList.add('on');
      for (let i = 0; i < PER_CLICK; i++) pending.push(setTimeout(spawn, i * 70));
    },
    /** Sweep the pile away and stop drawing. */
    clear() {
      for (const id of pending) clearTimeout(id);
      pending.length = 0;
      for (const { body, mesh } of cans) { world.removeBody(body); scene.remove(mesh); }
      cans.length = 0;
      cancelAnimationFrame(raf);
      raf = 0;
      canvas.classList.remove('on');
      renderer.clear();
    },
  };
}
