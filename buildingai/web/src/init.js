async function init() {
  // Each milestone is reported to the loading screen as it lands (boot.js);
  // the bar is the real progress of this function, not a timer.
  await Promise.all(LEVELS.map((l, i) => loadFloor(l).then(r => {
    bootProgress(1, 'Floor plan ' + (i === 0 ? 'ground' : i));
    return r;
  })));
  // Load cross-floor edges
  try {
    const ceResp = await fetch(`/api/building/cross-floor-edges?t=${Date.now()}`);
    crossFloorEdges = await ceResp.json();
  } catch(e) { console.log('No cross-floor edges'); }
  // Load equipment
  try {
    const eqResp = await fetch(`/api/equipment?t=${Date.now()}`);
    equipment = await eqResp.json();
  } catch(e) { console.log('No equipment data'); }
  bootProgress(1, 'Stairs, lifts and equipment');
  // Load inspection notes
  try {
    // Inspection notes not yet implemented in API
    inspectionNotes = [];
  } catch(e) { inspectionNotes = []; }

  const pw = floorData[LEVELS[0]].page.width, ph = floorData[LEVELS[0]].page.height;
  frustumSize = Math.max(pw, ph) * 1.1;
  updateCamera2D();
  buildAllEquipment();
  filterEquipment();
  switchTo3D();
  render();
  bootProgress(1, 'Assembling the storeys');

  // Load global occupancy and coverage
  fetchAndApplyOccupancy();
  fetchAndApplyCoverage();

  // === Check edit mode ===
  try {
    const cfgResp = await fetch('/api/config');
    const cfg = await cfgResp.json();
    if (cfg.edit_mode) {
      editModeEnabled = true;
      if (editModeEnabled) document.getElementById('edit-tools').style.display = 'flex';
    }
  } catch(e) {}

  // === Session & WebSocket ===
  // Not awaited: the boot should get the building on screen first; the
  // session connects in the background and pushes state when it is ready.
  initSession();
}
