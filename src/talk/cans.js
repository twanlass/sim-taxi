// Slide 2's gag: a click rains Dr Pepper cans down the screen and they pile up on the bottom edge.
// A transparent three.js canvas over the slide, with cannon-es doing the tumbling. Loaded on the
// first click (talk.js imports this lazily), and only ever on the talk page.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// A real 12oz can is 66mm across and 122mm tall; scaled so one is ~75px tall on a 780px window.
const RADIUS = 0.5;
const HEIGHT = 1.85;
// Tripled from 14, streamed at twice the rate so a click still empties in about a second and a half.
const PER_CLICK = 42;
const SPAWN_GAP_MS = 35;
// Collision groups (cannon-es's default group is 1, which is what the walls keep), and how long a
// fountain can flies through the others before it starts landing on them.
const WALL_GROUP = 1;
const CAN_GROUP = 2;
const GHOST_MS = 450;
// Past this the oldest can goes as each new one comes; three clicks' worth, after the tripling.
const MAX_CANS = 360;
// The pile lives in a shallow box in front of the slide, so it stacks rather than spreading back
// into the screen where perspective would shrink it to nothing.
const DEPTH = 1.6;
const FOV = 35;
const CAM_Z = 30;

/**
 * A can, not a tube: the foot narrows to a ring under a domed base, the shoulder tapers in to a
 * rolled rim over a recessed lid, and a ring-pull sits on top. Built centred on its own origin
 * with Y up, the way cannon-es's Cylinder is, so the physics' plain cylinder still fits it.
 * Groups: 0 the label, 1 the aluminium, 2 the opening, 3 the shoulder.
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
  // The shoulder is printed, not bare: on a real Dr Pepper can the red runs up the taper to the
  // rolled rim, and only the rim and the lid inside it are aluminium.
  const shoulder = new THREE.LatheGeometry([
    v(R, BODY_HI), v(0.49, BODY_HI + 0.08), v(0.45, h - 0.12), v(0.42, h - 0.04),
  ], 32);
  // The top, after a real can's: the rolled rim, a countersink groove inside it, then the lid
  // panel a little below the rim. The lathe stops at the panel's edge; the panel itself is a flat
  // shape below, because it has a hole in it.
  const LID_R = 0.34;
  const LID_Y = h - 0.05;
  const top = new THREE.LatheGeometry([
    v(0.42, h - 0.04), v(0.43, h - 0.005), v(0.415, h + 0.012), v(0.395, h + 0.002),
    v(0.385, h - 0.06), v(0.37, h - 0.078), v(0.355, h - 0.062), v(LID_R, LID_Y),
  ], 32);
  // The opening: a rounded slot opposite the finger loop, where the tab's nose pressed the flap
  // in, long along the tab's line. In the shape's XY plane, which turns face-up with its +Y on −Z.
  const MOUTH = { y: 0.2, rx: 0.085, ry: 0.13 };
  const MOUTH_DEPTH = 0.07;
  const lidShape = new THREE.Shape();
  lidShape.absarc(0, 0, LID_R, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absellipse(0, MOUTH.y, MOUTH.rx, MOUTH.ry, 0, Math.PI * 2, true);
  lidShape.holes.push(hole);
  const lid = new THREE.ShapeGeometry(lidShape, 24);
  lid.rotateX(-Math.PI / 2);
  lid.translate(0, LID_Y, 0);
  // The score: a raised bead tracing round the opening, a little outside its edge.
  const bead = new THREE.TorusGeometry(1, 0.1, 5, 32);
  bead.scale(MOUTH.rx + 0.022, MOUTH.ry + 0.022, 0.12);
  bead.rotateX(-Math.PI / 2);
  bead.translate(0, LID_Y + 0.004, -MOUTH.y);
  // The pull-tab: a flat plate along the lid's radius, the rivet near its middle, a finger hole at
  // the end toward the rim and the nose reaching out over the opening. Extruded upward from the lid
  // (the shape's +Z turns to +Y), so the loop end is shape −Y and lands on +Z.
  const tabShape = new THREE.Shape();
  tabShape.moveTo(-0.075, -0.24);
  tabShape.lineTo(0.075, -0.24);
  tabShape.quadraticCurveTo(0.09, -0.24, 0.09, -0.22);
  tabShape.lineTo(0.08, 0.06);
  tabShape.quadraticCurveTo(0.075, 0.1, 0, 0.11);
  tabShape.quadraticCurveTo(-0.075, 0.1, -0.08, 0.06);
  tabShape.lineTo(-0.09, -0.22);
  tabShape.quadraticCurveTo(-0.09, -0.24, -0.075, -0.24);
  const finger = new THREE.Path();
  finger.absellipse(0, -0.16, 0.05, 0.055, 0, Math.PI * 2, true);
  tabShape.holes.push(finger);
  // Tilted about the rivet, finger loop up and nose dipping into the opening, and bevelled so its
  // edges catch the light: laid flat in the lid's own metal it shaded exactly like the lid and only
  // its outline showed.
  const tab = new THREE.ExtrudeGeometry(tabShape, {
    depth: 0.01, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2,
  });
  tab.rotateX(-Math.PI / 2);
  tab.rotateX(-0.12);
  tab.translate(0, LID_Y + 0.01, 0);
  const rivet = new THREE.SphereGeometry(0.03, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  rivet.scale(1, 0.6, 1);
  rivet.translate(0, LID_Y + 0.02, 0);
  // The hole has depth: a dark wall down from the lid and a floor at the bottom of it.
  const wall = new THREE.CylinderGeometry(1, 1, MOUTH_DEPTH, 24, 1, true);
  wall.scale(MOUTH.rx, 1, MOUTH.ry);
  wall.translate(0, LID_Y - MOUTH_DEPTH / 2, -MOUTH.y);
  const floorShape = new THREE.Shape();
  floorShape.absellipse(0, MOUTH.y, MOUTH.rx, MOUTH.ry, 0, Math.PI * 2);
  const floor = new THREE.ShapeGeometry(floorShape, 16);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, LID_Y - MOUTH_DEPTH, 0);
  const flat = (g) => (g.index ? g.toNonIndexed() : g);
  const metalParts = [bottom, top, lid, bead, tab, rivet];
  for (const g of metalParts) g.deleteAttribute('uv');
  const metal = mergeGeometries(metalParts.map(flat));
  const mouth = mergeGeometries([wall, floor].map(flat));
  // The label keeps its UVs for the texture; the metal needs none, so give it zeros to merge.
  const label = new THREE.CylinderGeometry(R, R, BODY_HI - BODY_LO, 32, 1, true).toNonIndexed();
  label.translate(0, (BODY_HI + BODY_LO) / 2, 0);
  metal.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(metal.attributes.position.count * 2), 2));
  return mergeGeometries([label, metal, mouth, shoulder.toNonIndexed()], true);
}

// The 1990s can's colours: a cherry red, the logo in a pale silver (the bare aluminium the ink
// leaves showing), and an orange stripe running alongside it.
const CAN_RED = '#8c1328';
const CAN_INK = '#dcd8d3';
const CAN_STRIPE_LO = '#c8361c';
const CAN_STRIPE_HI = '#ef6c2c';

/**
 * The label after the real can: "Dr" stacked over "Pepper", turned to run up the can reading
 * bottom to top at 70°, with the orange stripe parallel to it on the Pepper side. The canvas is the
 * label's own proportions (circumference by height, 3.14 by 1.35), so a pixel is square on the can
 * and the lettering isn't stretched round it.
 */
function labelTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round(1024 * (HEIGHT - 0.5) / (Math.PI * 2 * RADIUS));
  const W = c.width;
  const H = c.height;
  const g = c.getContext('2d');
  g.fillStyle = CAN_RED;
  g.fillRect(0, 0, W, H);
  const TILT = THREE.MathUtils.degToRad(70);
  const font = (px) => `700 ${px}px Georgia, 'Times New Roman', serif`;
  // Size the type so the two-line block, turned, fills 90% of the label's height: its run along the
  // can is the Pepper line's width at sin(TILT), plus about two lines of thickness at cos(TILT).
  g.font = font(100);
  const per = g.measureText('Pepper').width / 100;
  const F = (0.9 * H) / (per * Math.sin(TILT) + 1.8 * Math.cos(TILT));
  g.font = font(F);
  const run = g.measureText('Pepper').width;
  // Twice round the can, so the name faces the camera whichever way it lands; each copy is
  // clipped to its own half so the stripe can run off the label without reaching the other.
  for (const cx of [W / 4, (3 * W) / 4]) {
    g.save();
    g.beginPath();
    g.rect(cx - W / 4, 0, W / 2, H);
    g.clip();
    g.translate(cx, H / 2);
    g.rotate(-TILT);
    const x0 = -run / 2;
    // The stripe, below the Pepper line in the logo's own frame (to its right on the can), from
    // under the second letter on past the top of the label, with a fine silver rule along its edge.
    const y0 = 1.02 * F;
    const grad = g.createLinearGradient(x0, 0, x0 + run * 1.4, 0);
    grad.addColorStop(0, CAN_STRIPE_LO);
    grad.addColorStop(1, CAN_STRIPE_HI);
    g.fillStyle = grad;
    g.fillRect(x0 + 0.25 * run, y0, run * 1.4, 0.32 * F);
    g.fillStyle = CAN_INK;
    g.fillRect(x0 + 0.25 * run, y0 - 0.05 * F, run * 1.4, 0.025 * F);
    // Set tight, the way the can has it — Pepper's capital all but touching Dr's baseline — and
    // fattened with a stroke in the same ink, since Georgia's bold is lighter than the can's face.
    g.font = font(F);
    g.textBaseline = 'alphabetic';
    g.strokeStyle = CAN_INK;
    g.lineWidth = 0.035 * F;
    g.lineJoin = 'round';
    for (const [word, y] of [['Dr', 0], ['Pepper', 0.74 * F]]) {
      g.fillText(word, x0, y);
      g.strokeText(word, x0, y);
    }
    g.font = font(F * 0.18);
    g.fillText('®', x0 + run + 0.04 * F, 0.12 * F);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The slide's own photo as the room the cans reflect, so their highlights carry its colours (the
 * cream wall above, the navy desk below, the red shirt) rather than a studio's white. The print is
 * tilted with a transparent margin, so only its middle is used: stretched across an equirect
 * canvas, then again mirrored, so there's no seam where the two ends meet behind the pile.
 */
function photoEnvironment(img) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  // Inside the tilted print's corners on every side: every pixel of this crop of the 1538 x 1100
  // file is opaque (checked at a 4px pitch), so none of the margin's shadow gets in.
  const sx = W * 0.14, sy = H * 0.16, sw = W * 0.7, sh = H * 0.68;
  g.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 512);
  g.save();
  g.translate(1024, 0);
  g.scale(-1, 1);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 512);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createCans() {
  const canvas = document.createElement('canvas');
  canvas.id = 'cans';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral rather than ACES: ACES pulls the label's red toward orange and greys its white type.
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 100);
  camera.position.set(0, 0, CAM_Z);
  // Something to reflect. Both materials are metallic, and a metal's look is almost all reflection:
  // under only a hemisphere and a sun the first cut had nothing in its environment, so the
  // aluminium came out a flat mid-grey and the label a dull matte red. A studio room
  // (RoomEnvironment) fixed that but read white and clinical; the photo above them (photoEnvironment)
  // is what they'd really be reflecting. The photo is on the page and loaded by the time anyone
  // can click it, which is what brings this module in.
  const photo = document.querySelector('#kid .photo');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const reflect = () => {
    const tex = photoEnvironment(photo);
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
  };
  if (photo.complete) reflect(); else photo.addEventListener('load', reflect, { once: true });
  // The photo is a dim room (a black screen, a navy desk), so it's lifted a little.
  scene.environmentIntensity = 1.3;
  scene.add(new THREE.HemisphereLight(0xffe2bf, 0x7a5a48, 0.8));
  // A golden key from the upper left, and a cooler rim from behind on the right to pick out the
  // silhouette against the white slide.
  const sun = new THREE.DirectionalLight(0xffcf94, 2.6);
  sun.position.set(-6, 10, 12);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xdfe6ff, 1.8);
  rim.position.set(10, 4, -8);
  scene.add(rim);

  const geometry = canGeometry();
  const materials = [
    // Ink printed on aluminium under a lacquer: tinted metal underneath, a clear glossy coat on top,
    // which is what throws the white highlight across the red.
    new THREE.MeshPhysicalMaterial({
      map: labelTexture(), metalness: 0.55, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06,
    }),
    // Double-sided: the lid sits recessed inside the rim, and a lathe's inner face shows there.
    // Rough enough to read as aluminium rather than chrome: at 0.2 the rims mirrored the room's
    // softboxes as hard white bands.
    new THREE.MeshStandardMaterial({ color: 0xdcd8d0, metalness: 1, roughness: 0.34, side: THREE.DoubleSide }),
    // The opening's wall and floor; double-sided, since the wall is seen from inside the hole.
    new THREE.MeshStandardMaterial({ color: 0x0a0605, metalness: 0, roughness: 0.9, side: THREE.DoubleSide }),
    // The shoulder: the label's lacquered ink, in the same red so the two run on.
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(CAN_RED), metalness: 0.55, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06,
    }),
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
  /** A point on screen, in CSS pixels, to where it lands on the pile's middle plane (z = 0). */
  function toWorld(px, py) {
    return {
      x: (px / window.innerWidth * 2 - 1) * halfW,
      y: (1 - py / window.innerHeight * 2) * halfH,
    };
  }

  /** One can. With an `origin` it bursts out of that point; without, it falls from the top. */
  function spawn(origin) {
    if (cans.length >= MAX_CANS) {
      const old = cans.shift();
      world.removeBody(old.body);
      scene.remove(old.mesh);
    }
    const body = new CANNON.Body({
      mass: 1, shape, linearDamping: 0.05, angularDamping: 0.45,
      sleepSpeedLimit: 0.6, sleepTimeLimit: 0.4,
      collisionFilterGroup: CAN_GROUP,
    });
    const z = (Math.random() * 2 - 1) * (DEPTH - 0.6);
    body.quaternion.setFromEuler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    if (origin) {
      // A fountain out of the photo's cans: up toward the top of the screen and fanning outward,
      // then gravity takes it to the pile. At 8–16 up they peaked a fifth of the way up the screen
      // (v² / 2g against a 19-unit-tall view) and read as being squeezed out; 16–24 peaks between a
      // quarter and a half of it.
      const p = toWorld(origin.x, origin.y);
      body.position.set(p.x, p.y, z);
      body.velocity.set(-4 + Math.random() * 11, 16 + Math.random() * 8, 0);
      // Born inside the last few, so for the first moments of flight a can passes through the
      // others (walls only, CAN_GROUP masked out): left solid, the solver shoved every new can
      // out of the one before and the fountain came out as a push.
      body.collisionFilterMask = WALL_GROUP;
      pending.push(setTimeout(() => { body.collisionFilterMask = WALL_GROUP | CAN_GROUP; }, GHOST_MS));
      body.angularVelocity.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    } else {
      body.position.set((Math.random() * 2 - 1) * (halfW - 1.5), halfH + 2 + Math.random() * 6, z);
      body.velocity.set((Math.random() - 0.5) * 1.5, -4 - Math.random() * 4, 0);
      body.angularVelocity.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    }
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
    drop(origin) {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
      canvas.classList.add('on');
      for (let i = 0; i < PER_CLICK; i++) pending.push(setTimeout(() => spawn(origin), i * SPAWN_GAP_MS));
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
