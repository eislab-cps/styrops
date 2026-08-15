// sun.js — Realistic sun position for Luleå, Sweden with solar irradiance heatmap.
// Uses NOAA solar position algorithm. Dragging the sun changes time of day.
// 3D exterior walls for visualization and occlusion raycasting.

let sunGroup = new THREE.Group();
sunGroup.visible = false;
scene.add(sunGroup);

let sunActive = false;
let sunAzimuth = 180;
let sunElevation = 45;
const SUN_ORBIT_R = 300;

const SUN_LAT = 65.5848;
const SUN_LON = 22.1547;
const SUN_TZ = 2;

// Initialize to current time
let sunDate = new Date();
let sunHour = sunDate.getHours() + sunDate.getMinutes() / 60;

let exteriorEdgeCache = {};
let irradianceTintedMeshes = [];

// ── NOAA solar position ─────────────────────────────────────────

function solarPosition(date, hour, lat, lon, tz) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const jd = 367*y - Math.floor(7*(y+Math.floor((m+9)/12))/4) + Math.floor(275*m/9) + d + 1721013.5 + (hour-tz)/24;
  const jc = (jd-2451545)/36525;
  let L0 = (280.46646+jc*(36000.76983+0.0003032*jc))%360;
  const M = 357.52911+jc*(35999.05029-0.0001537*jc), Mr = M*rad;
  const C = Math.sin(Mr)*(1.914602-jc*(0.004817+0.000014*jc))+Math.sin(2*Mr)*(0.019993-0.000101*jc)+Math.sin(3*Mr)*0.000289;
  const omega = 125.04-1934.136*jc;
  const sunAppLon = L0+C-0.00569-0.00478*Math.sin(omega*rad);
  const obliq = 23+(26+(21.448-jc*(46.815+jc*(0.00059-jc*0.001813)))/60)/60+0.00256*Math.cos(omega*rad);
  const obliqRad = obliq*rad;
  const decl = Math.asin(Math.sin(obliqRad)*Math.sin(sunAppLon*rad));
  const y2 = Math.tan(obliqRad/2)**2, L0r = L0*rad;
  const eqTime = 4*deg*(y2*Math.sin(2*L0r)-2*0.016709*Math.sin(Mr)+4*0.016709*y2*Math.sin(Mr)*Math.cos(2*L0r)-0.5*y2*y2*Math.sin(4*L0r)-1.25*0.016709**2*Math.sin(2*Mr));
  const tst = ((hour-tz)*60+eqTime+4*lon)%1440;
  const ha = (tst/4<0?tst/4+180:tst/4-180)*rad;
  const latRad = lat*rad;
  const cosZ = Math.sin(latRad)*Math.sin(decl)+Math.cos(latRad)*Math.cos(decl)*Math.cos(ha);
  const zenith = Math.acos(Math.max(-1,Math.min(1,cosZ)));
  const elevation = 90-zenith*deg;
  let azimuth;
  const sinZ = Math.sin(zenith);
  if (Math.abs(sinZ)>0.001) { let cosAz=(Math.sin(decl)-Math.cos(zenith)*Math.sin(latRad))/(sinZ*Math.cos(latRad)); cosAz=Math.max(-1,Math.min(1,cosAz)); azimuth=Math.acos(cosAz)*deg; if(ha>0) azimuth=360-azimuth; } else azimuth=180;
  return { azimuth, elevation };
}

let sunPathCache = null;
function buildSunPath() {
  const key = sunDate.toISOString().slice(0, 10);
  if (sunPathCache && sunPathCache.dateKey === key) return sunPathCache.path;
  const path = [];
  for (let m = 0; m < 1440; m++) {
    const h = m / 60;
    const pos = solarPosition(sunDate, h, SUN_LAT, SUN_LON, SUN_TZ);
    if (pos.elevation > -2) path.push({ hour: h, az: pos.azimuth, el: pos.elevation });
  }
  sunPathCache = { dateKey: key, path };
  return path;
}

function recalcSun() {
  const pos = solarPosition(sunDate, sunHour, SUN_LAT, SUN_LON, SUN_TZ);
  sunAzimuth = pos.azimuth;
  sunElevation = pos.elevation;
}

// ── Sun visual ──────────────────────────────────────────────────

let sunSphere, sunLine, sunArcMesh;

function buildSunVisual() {
  sunSphere = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffdd44 }));
  sunGroup.add(sunSphere);
  sunSphere.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.15 })));
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  sunLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.3 }));
  sunGroup.add(sunLine);
}
buildSunVisual();

function buildSunArc() {
  if (sunArcMesh) { sunGroup.remove(sunArcMesh); sunArcMesh.geometry.dispose(); sunArcMesh.material.dispose(); sunArcMesh = null; }
  const c = getBuildingCentroid();
  const path = buildSunPath();
  const points = [];
  for (const p of path) {
    if (p.el < 0) continue;
    const az = p.az * Math.PI / 180, el = p.el * Math.PI / 180;
    points.push(new THREE.Vector3(c.x+SUN_ORBIT_R*Math.sin(az)*Math.cos(el), c.y+SUN_ORBIT_R*Math.cos(az)*Math.cos(el), SUN_ORBIT_R*Math.sin(el)));
  }
  if (points.length < 2) return;
  sunArcMesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.12 }));
  sunGroup.add(sunArcMesh);
}

function getBuildingCentroid() {
  const level = LEVELS[0];
  const data = floorData[level];
  if (!data || !data.rooms || data.rooms.length === 0) return { x: 0, y: 0 };
  const pw = data.page.width, ph = data.page.height;
  let sx = 0, sy = 0, n = 0;
  for (const room of data.rooms) { const [wx, wy] = pdfToWorld(room.center[0], room.center[1], pw, ph); sx += wx; sy += wy; n++; }
  return { x: sx / n, y: sy / n };
}

function updateSunPosition() {
  recalcSun();
  const c = getBuildingCentroid();
  if (sunElevation < 0) { sunSphere.visible = false; sunLine.visible = false; }
  else {
    sunSphere.visible = true; sunLine.visible = true;
    const az = sunAzimuth*Math.PI/180, el = sunElevation*Math.PI/180;
    const sx = c.x+SUN_ORBIT_R*Math.sin(az)*Math.cos(el), sy = c.y+SUN_ORBIT_R*Math.cos(az)*Math.cos(el), sz = SUN_ORBIT_R*Math.sin(el);
    sunSphere.position.set(sx, sy, sz);
    const p = sunLine.geometry.attributes.position.array;
    p[0]=sx;p[1]=sy;p[2]=sz;p[3]=c.x;p[4]=c.y;p[5]=0;
    sunLine.geometry.attributes.position.needsUpdate = true;
  }
  syncSunUI();
}

function syncSunUI() {
  const hh = Math.floor(sunHour), mm = Math.floor((sunHour-hh)*60);
  const timeStr = String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  const ti = document.getElementById('sunTime'); if (ti) ti.value = timeStr;
  const info = document.getElementById('sunInfo');
  if (info) info.textContent = sunElevation < 0 ? timeStr+' — below horizon' : timeStr+' — az '+Math.round(sunAzimuth)+'° el '+Math.round(sunElevation*10)/10+'°';
}

// ── Mouse drag ──────────────────────────────────────────────────

let sunDragging = false;

canvas.addEventListener('mousedown', (e) => {
  if (!sunActive || !is3DView || e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1), camera3D);
  if (raycaster.intersectObject(sunSphere, true).length > 0) { sunDragging = true; orbitControls.enabled = false; e.stopImmediatePropagation(); }
}, true);

canvas.addEventListener('mousemove', (e) => {
  if (!sunDragging) return;
  const c = getBuildingCentroid(), rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1), camera3D);
  const target = new THREE.Vector3();
  if (raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(c.x,c.y,0), SUN_ORBIT_R), target)) {
    const path = buildSunPath();
    let bestDist = Infinity, bestHour = sunHour;
    for (const p of path) {
      if (p.el < 0) continue;
      const az=p.az*Math.PI/180, el=p.el*Math.PI/180;
      const dx=target.x-(c.x+SUN_ORBIT_R*Math.sin(az)*Math.cos(el)), dy=target.y-(c.y+SUN_ORBIT_R*Math.cos(az)*Math.cos(el)), dz=target.z-SUN_ORBIT_R*Math.sin(el);
      const dist = dx*dx+dy*dy+dz*dz;
      if (dist < bestDist) { bestDist = dist; bestHour = p.hour; }
    }
    sunHour = bestHour;
    updateSunPosition();
    calculateAndApplyIrradiance();
  }
});

canvas.addEventListener('mouseup', () => { if (sunDragging) { sunDragging = false; orbitControls.enabled = true; } });

canvas.addEventListener('mousemove', (e) => {
  if (!sunActive || !is3DView || sunDragging) return;
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1), camera3D);
  canvas.style.cursor = raycaster.intersectObject(sunSphere, true).length > 0 ? 'grab' : '';
});

// ── Wall analysis ───────────────────────────────────────────────

function computeWallAnalysis(level) {
  if (exteriorEdgeCache[level]) return exteriorEdgeCache[level];
  const data = floorData[level];
  if (!data || !data.rooms) return { exteriorEdges: {}, corridorNeighbors: {} };
  const pw = data.page.width, ph = data.page.height;
  const roomById = {};
  for (const room of data.rooms) roomById[room.id] = room;

  const allEdges = [];
  for (const room of data.rooms) {
    const pts = room.polygon;
    if (pts.length < 3) continue;
    for (let i = 0; i < pts.length; i++) {
      const pa = pts[i], pb = pts[(i+1)%pts.length];
      const [ax,ay] = pdfToWorld(pa[0],pa[1],pw,ph), [bx,by] = pdfToWorld(pb[0],pb[1],pw,ph);
      const dx=bx-ax, dy=by-ay, len=Math.sqrt(dx*dx+dy*dy);
      if (len < 0.1) continue;
      allEdges.push({ roomId:room.id, a:{x:ax,y:ay}, b:{x:bx,y:by}, dx:dx/len, dy:dy/len, len, mx:(ax+bx)/2, my:(ay+by)/2 });
    }
  }

  const DIST_THRESH = 3.0, DOT_THRESH = -0.9;
  const edgeNeighbor = {};
  for (let i = 0; i < allEdges.length; i++) {
    if (edgeNeighbor[i] !== undefined) continue;
    const ei = allEdges[i];
    for (let j = i+1; j < allEdges.length; j++) {
      if (edgeNeighbor[j] !== undefined) continue;
      const ej = allEdges[j];
      if (ei.roomId === ej.roomId) continue;
      if (ei.dx*ej.dx+ei.dy*ej.dy > DOT_THRESH) continue;
      const dmx=ei.mx-ej.mx, dmy=ei.my-ej.my;
      if (Math.abs(-ej.dy*dmx+ej.dx*dmy) > DIST_THRESH) continue;
      if (Math.abs(ej.dx*dmx+ej.dy*dmy) > (ei.len+ej.len)/2+1.0) continue;
      edgeNeighbor[i] = ej.roomId; edgeNeighbor[j] = ei.roomId; break;
    }
  }

  const exteriorEdges = {}, corridorNeighbors = {};
  for (const room of data.rooms) { exteriorEdges[room.id] = []; corridorNeighbors[room.id] = []; }

  for (let i = 0; i < allEdges.length; i++) {
    const e = allEdges[i], neighborId = edgeNeighbor[i];
    let nx = -e.dy, ny = e.dx;
    const room = roomById[e.roomId];
    if (room) { const [cx,cy] = pdfToWorld(room.center[0],room.center[1],pw,ph); if (nx*(cx-e.mx)+ny*(cy-e.my)>0){nx=-nx;ny=-ny;} }
    if (neighborId === undefined) {
      exteriorEdges[e.roomId].push({ a:e.a, b:e.b, nx, ny, length:e.len });
    } else {
      const neighbor = roomById[neighborId];
      if (neighbor && neighbor.type === 'corridor') corridorNeighbors[e.roomId].push({ neighborId, wallLength:e.len });
    }
  }

  const result = { exteriorEdges, corridorNeighbors };
  exteriorEdgeCache[level] = result;
  return result;
}

function invalidateSunCache() {
  exteriorEdgeCache = {};
  extWallsBuilt = false;
  if (sunActive || showExtWalls) buildAllExtWalls();
  if (sunActive) calculateAndApplyIrradiance();
}

// ── 3D exterior walls & roof ────────────────────────────────────

let extWallGroup = new THREE.Group();
extWallGroup.visible = false;
scene.add(extWallGroup);
let extWallsBuilt = false;
let showExtWalls = false;

const WALL_HEIGHT = 20;

function buildExtWallsForLevel(levelIdx) {
  const level = LEVELS[levelIdx];
  const { exteriorEdges } = computeWallAnalysis(level);
  const data = floorData[level];
  if (!data || !data.rooms) return;

  const baseZ = levelIdx * FLOOR_SPACING;
  const topZ = baseZ + WALL_HEIGHT;
  const align = FLOOR_ALIGN[levelIdx] || { x:0, y:0 };

  for (const room of data.rooms) {
    const edges = exteriorEdges[room.id];
    if (!edges || edges.length === 0) continue;
    for (const edge of edges) {
      const ax = edge.a.x+align.x, ay = edge.a.y+align.y;
      const bx = edge.b.x+align.x, by = edge.b.y+align.y;

      // Wall quad (two triangles)
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        ax,ay,baseZ, bx,by,baseZ, bx,by,topZ,
        ax,ay,baseZ, bx,by,topZ,  ax,ay,topZ
      ]), 3));

      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0x8899bb, transparent: true, opacity: 0.35, side: THREE.DoubleSide
      }));
      mesh.userData = { isExtWall: true, roomId: room.id, level: levelIdx };
      extWallGroup.add(mesh);

      // Top edge line
      extWallGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(ax,ay,topZ), new THREE.Vector3(bx,by,topZ)]),
        new THREE.LineBasicMaterial({ color: 0xaabbdd, transparent: true, opacity: 0.5 })
      ));
    }
  }
}

function buildRoof() { /* removed */ }

function buildAllExtWalls() {
  removeExtWalls();
  try {
    for (let i = 0; i < LEVELS.length; i++) {
      if (floorData[LEVELS[i]]) buildExtWallsForLevel(i);
    }
    buildRoof();
  } catch(e) { console.warn('[sun] wall build error:', e); }
  extWallsBuilt = true;
  extWallGroup.visible = showExtWalls && is3DView;
  console.log('[sun] ext walls: ' + extWallGroup.children.length + ' objects, visible=' + extWallGroup.visible);
}

function removeExtWalls() {
  while (extWallGroup.children.length > 0) {
    const c = extWallGroup.children[0];
    extWallGroup.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
  extWallsBuilt = false;
}

function ensureExtWalls() {
  if (!extWallsBuilt) buildAllExtWalls();
}

// ── 3D occlusion ────────────────────────────────────────────────

const sunRaycaster = new THREE.Raycaster();

function isWallOccluded3D(mx, my, mz, nx, ny, sunDirX, sunDirY, sunEl) {
  const elRad = sunEl * Math.PI / 180;
  const cosEl = Math.cos(elRad), sinEl = Math.sin(elRad);
  const dir = new THREE.Vector3(sunDirX*cosEl, sunDirY*cosEl, sinEl).normalize();
  const origin = new THREE.Vector3(mx+nx*3, my+ny*3, mz);
  sunRaycaster.set(origin, dir);
  sunRaycaster.far = 1000;
  const hits = sunRaycaster.intersectObjects(extWallGroup.children, false);
  // Only count hits against actual wall meshes (not lines)
  for (const hit of hits) {
    if (hit.object.userData && hit.object.userData.isExtWall) return true;
  }
  return false;
}

// ── Irradiance calculation ──────────────────────────────────────

function calculateIrradiance(level) {
  const { exteriorEdges, corridorNeighbors } = computeWallAnalysis(level);
  const data = floorData[level];
  if (!data || !data.rooms) return {};

  const az = sunAzimuth*Math.PI/180, el = sunElevation*Math.PI/180;
  const sunDirX = Math.sin(az), sunDirY = Math.cos(az);
  // Two factors combine:
  // 1. cos(el) — angle of incidence on vertical walls (better at low sun)
  // 2. atmospheric transmission — sun weaker at low elevation (longer path through atmosphere)
  //    Air mass ≈ 1/sin(el), transmission ≈ 0.7^(AM^0.678)  (Meinel model)
  const sinEl = Math.sin(el);
  const wallAngle = Math.max(0, Math.cos(el));
  const airMass = sinEl > 0.01 ? 1 / sinEl : 100;
  const atmosphere = Math.pow(0.7, Math.pow(airMass, 0.678));
  const elevFactor = wallAngle * atmosphere;

  const levelIdx = LEVELS.indexOf(level);
  const wallMidZ = levelIdx * FLOOR_SPACING + WALL_HEIGHT / 2;
  const align = FLOOR_ALIGN[levelIdx] || {x:0,y:0};
  const use3D = extWallsBuilt && extWallGroup.children.length > 0;

  const directScores = {};
  for (const room of data.rooms) {
    const edges = exteriorEdges[room.id];
    if (!edges || edges.length === 0) { directScores[room.id] = 0; continue; }
    let score = 0, totalExtLen = 0;
    for (const edge of edges) {
      const dot = edge.nx*sunDirX + edge.ny*sunDirY;
      if (dot > 0) {
        let occluded = false;
        if (use3D) {
          const mx = (edge.a.x+edge.b.x)/2+align.x, my = (edge.a.y+edge.b.y)/2+align.y;
          occluded = isWallOccluded3D(mx, my, wallMidZ, edge.nx, edge.ny, sunDirX, sunDirY, sunElevation);
        }
        if (!occluded) score += dot * edge.length;
      }
      totalExtLen += edge.length;
    }
    if (totalExtLen > 0) score = score * elevFactor / totalExtLen;
    directScores[room.id] = score;
  }

  const INDIRECT_FACTOR = 0.10; // subtle secondary heating via corridors
  const scores = {};
  for (const room of data.rooms) {
    let score = directScores[room.id] || 0;
    const neighbors = corridorNeighbors[room.id];
    if (neighbors && neighbors.length > 0) {
      let indirect = 0;
      for (const { neighborId } of neighbors) { const cd = directScores[neighborId]||0; if(cd>indirect)indirect=cd; }
      score += indirect * INDIRECT_FACTOR;
    }
    const hasExt = exteriorEdges[room.id] && exteriorEdges[room.id].length > 0;
    const hasCor = neighbors && neighbors.length > 0;
    scores[room.id] = (!hasExt && !hasCor) ? -1 : score;
  }

  let maxScore = 0;
  for (const room of data.rooms) { if (room.type!=='corridor'&&scores[room.id]>maxScore) maxScore=scores[room.id]; }
  if (maxScore > 0) { for (const id in scores) { if(scores[id]>0)scores[id]/=maxScore; } }
  for (const room of data.rooms) { if(room.type==='corridor'&&scores[room.id]>0) scores[room.id]=Math.min(scores[room.id],0.15); }
  return scores;
}

// ── Heatmap coloring ────────────────────────────────────────────

const thermalStops = [
  {t:0.0,color:new THREE.Color(0x1a3a6c)},{t:0.2,color:new THREE.Color(0x2288aa)},
  {t:0.4,color:new THREE.Color(0x44bb44)},{t:0.6,color:new THREE.Color(0xddcc22)},
  {t:0.8,color:new THREE.Color(0xff8811)},{t:1.0,color:new THREE.Color(0xee2200)},
];
const shadowColor = new THREE.Color(0x18183a);

function irradianceColor(t) {
  t = Math.max(0,Math.min(1,t));
  const c = new THREE.Color();
  for (let i=0;i<thermalStops.length-1;i++) {
    if (t<=thermalStops[i+1].t) { c.lerpColors(thermalStops[i].color,thermalStops[i+1].color,(t-thermalStops[i].t)/(thermalStops[i+1].t-thermalStops[i].t)); return c; }
  }
  c.copy(thermalStops[thermalStops.length-1].color); return c;
}

function clearIrradianceTint() {
  for (const {mesh,origColor,origOpacity} of irradianceTintedMeshes) { mesh.material.color.setHex(origColor); mesh.material.opacity=origOpacity; }
  irradianceTintedMeshes = [];
}

function applyIrradianceToLevel(level) {
  const fg = floorGroups[level]; if (!fg) return;
  const scores = calculateIrradiance(level);
  for (const mesh of fg.meshes) {
    const room = mesh.userData; if (!room) continue;
    const score = scores[room.id];
    const origColor = mesh.material.color.getHex(), origOpacity = mesh.material.opacity;
    if (sunElevation<0) { mesh.material.color.copy(shadowColor); mesh.material.opacity=0.45; }
    else if (score<0) { mesh.material.color.copy(shadowColor); mesh.material.opacity=0.55; }
    else if (score<0.01) { mesh.material.color.copy(thermalStops[0].color); mesh.material.opacity=0.5; }
    else { mesh.material.color.copy(irradianceColor(score)); mesh.material.opacity=0.55+score*0.3; }
    irradianceTintedMeshes.push({mesh,origColor,origOpacity});
  }
}

function calculateAndApplyIrradiance() {
  clearIrradianceTint();
  if (!sunActive) return;
  ensureExtWalls();
  for (const level of LEVELS) { if(floorData[level]) applyIrradianceToLevel(level); }
  render();
}

// ── Legend ───────────────────────────────────────────────────────

function buildLegend() {
  const el = document.getElementById('sunLegend'); if (!el) return;
  const gs = thermalStops.map(s=>'#'+s.color.getHexString()+' '+(s.t*100)+'%').join(', ');
  el.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-top:2px"><div style="display:flex;align-items:center;gap:3px"><div style="width:12px;height:12px;border-radius:2px;background:#'+shadowColor.getHexString()+';border:1px solid #444"></div><span>Shadow</span></div></div><div style="margin-top:4px"><div style="height:10px;border-radius:3px;background:linear-gradient(to right, '+gs+');border:1px solid #333"></div><div style="display:flex;justify-content:space-between;margin-top:1px"><span>Low</span><span>High</span></div></div>';
}

// ── Toggle & visibility ─────────────────────────────────────────

function toggleSun(on) {
  sunActive = on;
  sunGroup.visible = on && is3DView;
  const controls = document.getElementById('sunSliders');
  if (controls) controls.style.display = on ? 'block' : 'none';
  const legend = document.getElementById('sunLegend');
  if (legend) { legend.style.display = on?'block':'none'; if(on)buildLegend(); }

  if (on) {
    // Auto-set to current date/time
    const now = new Date();
    sunDate = now;
    sunHour = now.getHours() + now.getMinutes() / 60;

    const dateInput = document.getElementById('sunDate');
    if (dateInput) {
      const y=sunDate.getFullYear(),m=sunDate.getMonth()+1,d=sunDate.getDate();
      dateInput.value = y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    }

    ensureExtWalls();
    buildSunArc();
    updateSunPosition();
    calculateAndApplyIrradiance();
  } else {
    clearIrradianceTint();
    canvas.style.cursor = '';
  }
  render();
}

function updateSunVisibility() {
  sunGroup.visible = sunActive && is3DView;
  extWallGroup.visible = showExtWalls && is3DView;
  if (!is3DView) canvas.style.cursor = '';
  render();
}

// ── Event wiring ────────────────────────────────────────────────

document.getElementById('showExtWalls').addEventListener('change', function() {
  showExtWalls = this.checked;
  if (showExtWalls) { ensureExtWalls(); extWallGroup.visible = is3DView; }
  else extWallGroup.visible = false;
  render();
});

document.getElementById('showSun').addEventListener('change', function() { toggleSun(this.checked); });

document.getElementById('sunDate').addEventListener('input', function() {
  const p = this.value.split('-');
  if (p.length===3) { sunDate=new Date(+p[0],+p[1]-1,+p[2]); sunPathCache=null; buildSunArc(); updateSunPosition(); calculateAndApplyIrradiance(); }
});

document.getElementById('sunTime').addEventListener('input', function() {
  const p = this.value.split(':');
  if (p.length>=2) { sunHour=+p[0]+(+p[1])/60; updateSunPosition(); calculateAndApplyIrradiance(); }
});
