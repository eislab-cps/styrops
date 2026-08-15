// robot.mjs — the mower: body, wheels, status LED, headlights, trail, and the
// SLAM-estimate overlay.
//
// COORDINATE CONVENTION (see scene.mjs):
//   three.x = model.x,  three.y = up,  three.z = -model.y
//   The body is modelled with local +X = forward, so model theta (CCW from +x)
//   maps straight onto rotation.y = theta:
//     rot_y(θ) · (1,0,0) = (cosθ, 0, -sinθ) = the three-space image of the
//     model heading vector (cosθ, sinθ).
//
// The SLAM overlay is OFF by default and driven by the "SLAM" view toggle. It
// is deliberately drawn as a hologram — fresnel rim + edge outline + ground
// ring, no solid faces — so nobody mistakes it for a second physical robot.

import * as THREE from 'three';
import { contactDecal } from './obstacles.mjs';
import { glowSprite } from './textures.mjs';
import { heightAt } from './terrain.mjs';

const STATE_COLOR = {
  idle: 0x7dd3fc,
  mowing: 0x34d399,
  docking: 0xfbbf24,
  charging: 0x22d3ee,
  stuck: 0xf87171,
  manual: 0xa78bfa,
  error: 0xef4444,
};

const HOLO = 0x5ad9ff;
const TRAIL_MAX = 240;
const TRAIL_STEP2 = 0.09 * 0.09;

/** Rounded-rectangle Shape in the extrude plane (shape.x = forward, shape.y = lateral). */
function roundedPlan(len, wid, r) {
  const s = new THREE.Shape();
  const hx = len / 2, hy = wid / 2;
  s.moveTo(-hx + r, -hy);
  s.lineTo(hx - r, -hy);
  s.quadraticCurveTo(hx, -hy, hx, -hy + r);
  s.lineTo(hx, hy - r);
  s.quadraticCurveTo(hx, hy, hx - r, hy);
  s.lineTo(-hx + r, hy);
  s.quadraticCurveTo(-hx, hy, -hx, hy - r);
  s.lineTo(-hx, -hy + r);
  s.quadraticCurveTo(-hx, -hy, -hx + r, -hy);
  return s;
}

/**
 * Extrude a plan shape upwards. ExtrudeGeometry lives in XY with depth along
 * +Z; rotateX(-PI/2) maps (px,py,pz) → (px, pz, -py), i.e. shape-x → forward,
 * shape-y → lateral, depth → height. Exactly our convention.
 */
function extrudeUp(shape, depth, bevel = 0, seg = 10) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3,
    curveSegments: seg,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Side walls only (no caps) around a rounded plan. A capped shell shows its
 * flat top face edge-on to a low camera, and a fresnel term makes that face
 * glow as a solid slab — exactly the "confusing blue box" we are avoiding.
 * With walls alone the fresnel lights only the silhouette, which reads as a
 * hologram. aFade darkens the bottom so it looks projected from the ground up.
 */
function holoShell(len, wid, r, h) {
  const pts = roundedPlan(len, wid, r).getPoints(12);
  const pos = [], nrm = [], fade = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const nx = dy / L, ny = -dx / L;              // outward normal, CCW plan
    // shape (sx, sy) → three (sx, y, -sy); see the coordinate convention
    const push = (p, y, f) => {
      pos.push(p.x, y, -p.y); nrm.push(nx, 0, -ny); fade.push(f);
    };
    push(a, 0, 0.15); push(b, 0, 0.15); push(b, h, 1.0);
    push(a, 0, 0.15); push(b, h, 1.0); push(a, h, 1.0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  return { geo: g, pts };
}

/**
 * Ground normal in THREE space at a model point. Y = f(X, -Z), so the surface
 * normal is (-df/dx, 1, +df/dy) once the z flip is folded in.
 */
const _UP = new THREE.Vector3(0, 1, 0);
function groundNormal(x, y, out) {
  const e = 0.35;
  const gx = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
  const gy = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
  return out.set(-gx, 1, gy).normalize();
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class RobotView {
  constructor(parent) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = 'robot';
    parent.add(this.group);

    const dark = new THREE.MeshStandardMaterial({ color: 0x3c434c, roughness: 0.48, metalness: 0.18 });
    const darker = new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: 0.36, metalness: 0.30 });
    const orange = new THREE.MeshStandardMaterial({
      color: 0xff6600, roughness: 0.38, metalness: 0.10,
      emissive: 0xff6600, emissiveIntensity: 0.22,
    });

    // ---- chassis: rounded, bevelled shell -----------------------------------
    const bodyGeo = extrudeUp(roundedPlan(0.70, 0.50, 0.15), 0.145, 0.030);
    const body = new THREE.Mesh(bodyGeo, dark);
    body.position.y = 0.105;
    body.castShadow = true; body.receiveShadow = true;
    this.group.add(body);

    // blade-height skirt: thin dark lip around the bottom edge
    const skirt = new THREE.Mesh(extrudeUp(roundedPlan(0.715, 0.515, 0.155), 0.035, 0.010), darker);
    skirt.position.y = 0.072;
    skirt.castShadow = true;
    this.group.add(skirt);

    // upper cowl, inset and tapered
    const cowl = new THREE.Mesh(extrudeUp(roundedPlan(0.56, 0.42, 0.14), 0.055, 0.020), darker);
    cowl.position.set(-0.025, 0.255, 0);
    cowl.castShadow = true;
    this.group.add(cowl);

    // ---- Husqvarna orange accents: waist stripe + X on the deck -------------
    const stripe = new THREE.Mesh(extrudeUp(roundedPlan(0.722, 0.522, 0.158), 0.026), orange);
    stripe.position.y = 0.163;
    this.group.add(stripe);

    const barGeo = new THREE.BoxGeometry(0.34, 0.014, 0.052);
    for (const a of [0.62, -0.62]) {
      const bar = new THREE.Mesh(barGeo, orange);
      bar.position.set(-0.02, 0.312, 0);
      bar.rotation.y = a;
      this.group.add(bar);
    }

    // ---- wheels -------------------------------------------------------------
    const tyre = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.95 });
    const hub = new THREE.MeshStandardMaterial({ color: 0x40464e, roughness: 0.5, metalness: 0.5 });
    const wheelGeo = new THREE.CylinderGeometry(0.105, 0.105, 0.062, 18);
    wheelGeo.rotateX(Math.PI / 2);                     // axis +Y → +Z (lateral)
    const treadGeo = new THREE.TorusGeometry(0.098, 0.019, 5, 13);  // faceted = knobbly tread
    const hubGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.068, 10);
    hubGeo.rotateX(Math.PI / 2);

    this.wheels = [];
    for (const z of [-0.245, 0.245]) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(wheelGeo, tyre);
      t.castShadow = true;
      w.add(t);
      const tr = new THREE.Mesh(treadGeo, tyre);
      w.add(tr);
      const hb = new THREE.Mesh(hubGeo, hub);
      w.add(hb);
      w.position.set(-0.175, 0.105, z);
      this.group.add(w);
      this.wheels.push(w);
    }

    // front caster wheels
    const castGeo = new THREE.CylinderGeometry(0.048, 0.048, 0.030, 12);
    castGeo.rotateX(Math.PI / 2);
    for (const z of [-0.105, 0.105]) {
      const c = new THREE.Mesh(castGeo, tyre);
      c.position.set(0.245, 0.048, z);
      c.castShadow = true;
      this.group.add(c);
      const fork = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.06, 0.075), hub);
      fork.position.set(0.245, 0.093, z);
      this.group.add(fork);
    }

    // ---- cutting disc with three razor blades -------------------------------
    this.disc = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.10, 0.10, 0.010, 18),
      new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.3, metalness: 0.85 })
    );
    this.disc.add(plate);
    const bladeGeo = new THREE.BoxGeometry(0.075, 0.003, 0.016);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(bladeGeo, new THREE.MeshStandardMaterial({
        color: 0xd7dde3, roughness: 0.25, metalness: 0.9,
      }));
      const a = i * Math.PI * 2 / 3;
      b.position.set(Math.cos(a) * 0.11, -0.004, Math.sin(a) * 0.11);
      b.rotation.y = -a;
      this.disc.add(b);
    }
    this.disc.position.set(0.02, 0.052, 0);
    this.group.add(this.disc);

    // ---- status LED ---------------------------------------------------------
    this.ledMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.idle, toneMapped: false });
    this.led = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.10, 4, 8), this.ledMat);
    this.led.rotation.x = Math.PI / 2;
    this.led.position.set(0.175, 0.322, 0);
    this.group.add(this.led);

    this.ledGlowMat = new THREE.SpriteMaterial({
      map: glowSprite(),
      color: STATE_COLOR.idle, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.ledGlow = new THREE.Sprite(this.ledGlowMat);
    this.ledGlow.scale.setScalar(0.30);
    this.ledGlow.position.copy(this.led.position);
    this.group.add(this.ledGlow);

    // ---- headlights ---------------------------------------------------------
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2d4, toneMapped: false });
    for (const z of [-0.13, 0.13]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), this.lampMat);
      lamp.position.set(0.325, 0.185, z);
      this.group.add(lamp);
    }
    const coneGeo = new THREE.ConeGeometry(0.40, 1.7, 18, 1, true);
    coneGeo.rotateZ(Math.PI / 2);                       // cone axis +Y → +X
    coneGeo.translate(1.15, 0, 0);
    this.beam = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: 0xfff0cf, transparent: true, opacity: 0.075,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false,
    }));
    this.beam.position.y = 0.185;
    this.beam.visible = false;
    this.group.add(this.beam);

    // grounding blob travels with the robot
    this.decal = contactDecal(0, 0, 0.46, 0.05, 0.55);
    this.decal.position.set(0, 0.05, 0);
    this.group.add(this.decal);

    // ---- SLAM overlay (hologram, off by default) ---------------------------
    this.showGhost = false;
    this.holoUni = {
      uColor: { value: new THREE.Color(HOLO) },
      uOpacity: { value: 0.35 },
      uTime: { value: 0 },
    };
    this.ghost = new THREE.Group();

    const { geo: shellGeo, pts: shellPts } = holoShell(0.74, 0.54, 0.16, 0.28);
    const shell = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({
      uniforms: this.holoUni,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aFade;
        varying vec3 vN; varying vec3 vP; varying float vWy; varying float vFade;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vP = mv.xyz;
          vWy = (modelMatrix * vec4(position, 1.0)).y;
          vFade = aFade;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
        varying vec3 vN; varying vec3 vP; varying float vWy; varying float vFade;
        void main() {
          // fresnel rim: walls edge-on to the camera glow, walls facing us fade
          float f = 1.0 - abs(dot(normalize(vN), normalize(-vP)));
          f = pow(clamp(f, 0.0, 1.0), 2.6);
          // holographic scan bands drifting up the shell
          float band = 0.70 + 0.30 * sin(vWy * 110.0 - uTime * 4.5);
          float i = f * band * vFade;
          gl_FragColor = vec4(uColor * (0.10 + i * 1.9), uOpacity * (0.05 + i * 1.25));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    shell.position.y = 0.03;
    this.ghost.add(shell);

    // crisp top and bottom rims
    const rimMat = new THREE.LineBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false,
    });
    for (const [y, op] of [[0.30, 0.7], [0.03, 0.3]]) {
      const m = rimMat.clone();
      m.opacity = op;
      const rim = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          shellPts.map((p) => new THREE.Vector3(p.x, y, -p.y))),
        m
      );
      this.ghost.add(rim);
    }

    // footprint ring + heading tick, so orientation error is readable too
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.40, 0.435, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: HOLO, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false,
      })
    );
    ring.position.y = 0.012;
    this.ghost.add(ring);

    const tick = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.40, 0.014, 0), new THREE.Vector3(0.62, 0.014, 0),
      ]),
      new THREE.LineBasicMaterial({ color: HOLO, transparent: true, opacity: 0.6, toneMapped: false })
    );
    this.ghost.add(tick);

    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    parent.add(this.ghost);

    // dotted leader line: truth ↔ estimate, so the drift is legible
    this.errLine = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineDashedMaterial({
        color: HOLO, transparent: true, opacity: 0.6,
        dashSize: 0.05, gapSize: 0.075, toneMapped: false,
      })
    );
    this.errLine.visible = false;
    this.errLine.frustumCulled = false;
    this.errLine.renderOrder = 5;
    parent.add(this.errLine);

    // ---- trail --------------------------------------------------------------
    const tGeo = new THREE.BufferGeometry();
    this.trailPos = new Float32Array(TRAIL_MAX * 3);
    this.trailCol = new Float32Array(TRAIL_MAX * 4);
    this.trailPosAttr = new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.trailColAttr = new THREE.BufferAttribute(this.trailCol, 4).setUsage(THREE.DynamicDrawUsage);
    tGeo.setAttribute('position', this.trailPosAttr);
    tGeo.setAttribute('color', this.trailColAttr);
    tGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(tGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 3;
    parent.add(this.trail);
    this.trailN = 0;

    // ---- interpolation state ------------------------------------------------
    this.cur = { x: 0, y: 0, th: 0 };
    this.tgt = { x: 0, y: 0, th: 0 };
    this.curGhost = { x: 0, y: 0, th: 0 };
    this.tgtGhost = null;
    this.hasPose = false;
    this.state = 'idle';
    this.batt = 100;
    this.bladeOn = false;
    this.drift = 0;
    this.clock = 0;
    this._n = new THREE.Vector3(0, 1, 0);
    this._qTilt = new THREE.Quaternion();
    this._qYaw = new THREE.Quaternion();
  }

  /** Feed a model.RobotStatus straight from REST or the WS "status" frame. */
  setStatus(st) {
    if (!st) return;
    const p = st.pose;
    if (p) {
      this.tgt.x = p.x; this.tgt.y = p.y; this.tgt.th = p.theta;
      if (!this.hasPose) {
        this.cur.x = p.x; this.cur.y = p.y; this.cur.th = p.theta;
        this.hasPose = true;
        this.pushTrail(p.x, p.y, true);
      }
    }
    this.state = st.state || 'idle';
    this.bladeOn = !!st.blade_on;
    this.batt = st.battery ? st.battery.percent : 100;

    const e = st.est_pose;
    if (e) {
      if (!this.tgtGhost) { this.curGhost.x = e.x; this.curGhost.y = e.y; this.curGhost.th = e.theta; }
      this.tgtGhost = { x: e.x, y: e.y, th: e.theta };
    } else {
      this.tgtGhost = null;
    }

    const c = STATE_COLOR[this.state] || STATE_COLOR.idle;
    this.ledMat.color.setHex(c);
    this.ledGlowMat.color.setHex(c);
  }

  setVisibility({ trail, ghost }) {
    if (trail !== undefined) this.trail.visible = trail;
    if (ghost !== undefined) this.showGhost = ghost;
  }

  /** True when the SLAM overlay is actually on screen (HUD label follows it). */
  get ghostActive() { return this.ghost.visible; }

  resetTrail() {
    this.trailN = 0;
    this.trail.geometry.setDrawRange(0, 0);
  }

  pushTrail(x, y, force) {
    const n = this.trailN;
    if (n > 0 && !force) {
      const dx = x - this.trailPos[(n - 1) * 3];
      const dz = -y - this.trailPos[(n - 1) * 3 + 2];
      if (dx * dx + dz * dz < TRAIL_STEP2) return;
    }
    if (n >= TRAIL_MAX) {
      this.trailPos.copyWithin(0, 3);
      this.trailN = TRAIL_MAX - 1;
    }
    const i = this.trailN * 3;
    this.trailPos[i] = x;
    this.trailPos[i + 1] = heightAt(x, y) + 0.055;
    this.trailPos[i + 2] = -y;
    this.trailN++;

    for (let k = 0; k < this.trailN; k++) {
      const t = k / Math.max(1, this.trailN - 1);
      const o = k * 4;
      this.trailCol[o] = 1.0 * t + 0.15;
      this.trailCol[o + 1] = 0.42 * t + 0.05;
      this.trailCol[o + 2] = 0.06 * t;
      this.trailCol[o + 3] = t * t * 0.85;
    }
    this.trail.geometry.setDrawRange(0, this.trailN);
    this.trailPosAttr.needsUpdate = true;
    this.trailColAttr.needsUpdate = true;
  }

  /** Per-frame smoothing. dt in real seconds. */
  update(dt) {
    if (!this.hasPose) return;
    this.clock += dt;
    this.holoUni.uTime.value = this.clock;

    const dx = this.tgt.x - this.cur.x, dy = this.tgt.y - this.cur.y;
    const far = dx * dx + dy * dy > 2.25;           // teleport / fast sim → snap
    const a = far ? 1 : 1 - Math.exp(-11 * dt);
    this.cur.x += dx * a;
    this.cur.y += dy * a;
    this.cur.th += shortestAngle(this.cur.th, this.tgt.th) * (far ? 1 : 1 - Math.exp(-9 * dt));

    // Sit on the ground AND lean with it: a mower that stays dead level while
    // the lawn rolls underneath it is the first thing that reads as fake.
    this.group.position.set(this.cur.x, heightAt(this.cur.x, this.cur.y), -this.cur.y);
    groundNormal(this.cur.x, this.cur.y, this._n);
    this._qTilt.setFromUnitVectors(_UP, this._n);
    this._qYaw.setFromAxisAngle(_UP, this.cur.th);
    this.group.quaternion.copy(this._qTilt).multiply(this._qYaw);

    this.pushTrail(this.cur.x, this.cur.y, false);

    if (this.bladeOn) this.disc.rotation.y += dt * 26;
    const speed = Math.hypot(dx, dy) * 4;
    for (const w of this.wheels) w.rotation.z -= dt * (2 + speed * 12);

    const mowing = this.state === 'mowing';
    this.beam.visible = mowing;
    this.lampMat.color.setHex(mowing ? 0xfff2d4 : 0x4a4a44);

    let amp = 1;
    if (this.batt <= 20) amp = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.clock * (this.batt <= 10 ? 9 : 5)));
    else if (mowing) amp = 0.82 + 0.18 * Math.sin(this.clock * 2.4);
    this.ledGlowMat.opacity = 0.25 + 0.5 * amp;
    this.ledGlow.scale.setScalar(0.26 + 0.10 * amp);

    // ---- SLAM overlay ------------------------------------------------------
    const show = this.showGhost && !!this.tgtGhost;
    this.ghost.visible = show;
    this.errLine.visible = show;
    if (show) {
      const g = this.tgtGhost;
      const gdx = g.x - this.curGhost.x, gdy = g.y - this.curGhost.y;
      const gfar = gdx * gdx + gdy * gdy > 2.25;
      const ga = gfar ? 1 : 1 - Math.exp(-11 * dt);
      this.curGhost.x += gdx * ga;
      this.curGhost.y += gdy * ga;
      this.curGhost.th += shortestAngle(this.curGhost.th, g.th) * (gfar ? 1 : 1 - Math.exp(-9 * dt));
      this.ghost.position.set(this.curGhost.x,
        heightAt(this.curGhost.x, this.curGhost.y) + 0.002, -this.curGhost.y);
      this.ghost.rotation.y = this.curGhost.th;

      this.drift = Math.hypot(this.curGhost.x - this.cur.x, this.curGhost.y - this.cur.y);

      const lp = this.errLine.geometry.attributes.position;
      lp.array[0] = this.cur.x;
      lp.array[1] = heightAt(this.cur.x, this.cur.y) + 0.30;
      lp.array[2] = -this.cur.y;
      lp.array[3] = this.curGhost.x;
      lp.array[4] = heightAt(this.curGhost.x, this.curGhost.y) + 0.30;
      lp.array[5] = -this.curGhost.y;
      lp.needsUpdate = true;
      this.errLine.computeLineDistances();
    }
  }

  worldPos(out) {
    return out.set(this.cur.x, heightAt(this.cur.x, this.cur.y) + 0.2, -this.cur.y);
  }
}
