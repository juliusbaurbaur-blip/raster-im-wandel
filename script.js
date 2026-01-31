/* Interactive flip-grid with STABLE and LABIL modes
   - 40x40 grid (1600 cells)
   - Two distinct modes with different behaviors
   - Mode 1: STABLE (calm, focused, monochrome)
   - Mode 2: LABIL (chaotic, expansive, colorful)
*/
(function () {
  if (typeof THREE === 'undefined') {
    console.error('Three.js not loaded');
    alert('Three.js did not load. Please check internet connection or file path.');
    return;
  }

  // Grid config
  const COLS = 40;
  const ROWS = 40;
  const TOTAL = COLS * ROWS;
  const MAX_ANGLE_DEG = 180;
  const MAX_ANGLE = MAX_ANGLE_DEG * Math.PI / 180;

  // visual config
  const BG = '#1a1a1a';
  const FG = '#fff';

  const canvas = document.getElementById('gridCanvas');
  // Three.js setup
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
  dirLight.position.set(-100, 40, 80);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 4096;
  dirLight.shadow.mapSize.height = 4096;
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.02;
  dirLight.shadow.radius = 4; // Softer shadows
  const d = 50;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  scene.add(dirLight);

  // Shadow receiver plane - Removed to prevent background shadows
  // const planeGeom = new THREE.PlaneGeometry(200, 200);
  // const planeMat = new THREE.ShadowMaterial({ opacity: 0.5 });
  // const plane = new THREE.Mesh(planeGeom, planeMat);
  // plane.position.z = -5;
  // plane.receiveShadow = true;
  // scene.add(plane);

  // Camera will be set in resize
  // Camera will be set in resize
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);

  const group = new THREE.Group();
  scene.add(group);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Geometries - centered at origin by default. 
  // We want pivot at LEFT edge. 
  // Width is 0.9. Left edge is at x = -0.45.
  // To make origin (0,0) be the left edge, we shift vertices right by +0.45.
  const geomSquare = new THREE.PlaneGeometry(0.9, 0.9);
  geomSquare.translate(0.45, 0, 0);

  const geomCircle = new THREE.CircleGeometry(0.45, 32);
  geomCircle.translate(0.45, 0, 0);

  // Square side is 0.9.
  // We want equilateral triangle with side s=0.9.
  // Radius R of circumcircle: s = R * sqrt(3) => R = s / sqrt(3).
  const triRadius = 0.9 / Math.sqrt(3);
  const geomTriangle = new THREE.CircleGeometry(triRadius, 3);
  // Default points East (tip at +R, base at -R/2).
  // We want the vertical base to be at the pivot (x=0).
  // Base x is -R/2.
  // Translate by +R/2.
  geomTriangle.translate(triRadius / 2, 0, 0);

  // Use InstancedMesh for performance (60fps with 1600 items)
  // We need 3 layers: Squares, Circles, Triangles. 
  // We'll toggle visibility by scaling 0 or moving instances to infinity, or just managing active set?
  // Easiest: have all 3, and for each cell, set the matrix for the active shape and set others to scale=0.
  // Easiest: have all 3, and for each cell, set the matrix for the active shape and set others to scale=0.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0
  });

  let meshSquares, meshCircles, meshTriangles, meshHit;

  // Reuse convenient dummy for matrix calculations
  const dummy = new THREE.Object3D();
  const _color = new THREE.Color();

  let MODE = 'labil'; // global mode state

  // Mode settings - define behavior for each mode
  const MODES = {
    labil: {
      startDeg: 30,
      decay: 0.6,         // stronger falloff
      minDeg: 4,
      maxFlutterAmpDeg: 0.8, // very little flutter
      minFlutterAmpDeg: 0.3,
      flutterFreqMin: 0.3,
      flutterFreqMax: 0.7,
      colors: ['#888888', '#aaaaaa', '#666666'], // grayscale
      shapeWeights: { square: 0.40, circle: 0.40, triangle: 0.20 }
    },
    stable: {
      startDeg: 90,       // aggressive flip angle
      decay: 0.78,         // softer falloff
      minDeg: 6,
      maxFlutterAmpDeg: 4.0, // strong flutter
      minFlutterAmpDeg: 2.0,
      flutterFreqMin: 0.8,
      flutterFreqMax: 2.0,
      colors: ['#3a5eff'], // accent color (blue)
      shapeWeights: { square: 0.3, circle: 0.3, triangle: 0.4 }
    }
  };

  // Function to get current mode config
  function cfg() {
    return MODES[MODE];
  }

  // Build attenuation degs based on mode
  function buildAttenuationDegs() {
    const config = cfg();
    const out = [];
    let d = config.startDeg;
    while (out.length < COLS && d >= config.minDeg) {
      out.push(Math.max(0, Math.round(d)));
      d *= config.decay;
    }
    if (out.length === 0) out.push(config.startDeg);
    return out;
  }

  let ATTENUATION_DEGS = buildAttenuationDegs();
  let HORIZ_RADIUS = ATTENUATION_DEGS.length - 1;

  // state for each cell
  const cells = new Array(TOTAL);

  function initCells() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        cells[idx] = {
          shape: 'square',
          color: '#ffffff',
          angle: 0,
          targetAngle: 0,
          zOffset: 0,
          lastActivationSeed: -1,
          pendingShape: null,
          pendingColor: null,
          reaction: 0,
          flipped: false,
          flippedMaxAngle: null,
          flutterPhase: Math.random() * Math.PI * 2,
          flutterFreq: 0.6 + Math.random() * 1.4,
          flutterAmpDeg: 2.0 + Math.random() * 3.0,
          currentIntensity: 0,
          flutterActive: false,
          baseFlutterAmpDeg: 2.0 + Math.random() * 3.0,
          baseFlutterFreq: 0.6 + Math.random() * 1.4,
          // stability helpers for STABLE mode
          labilActivationCount: 0,
          labilLastSeed: -1,
          cooldown: 0,
          // time in seconds until this cell reverts to default (white square) in STABLE mode
          revertTimer: null,
          // which mode last modified this cell: 'labil', 'stable' or null
          modifiedBy: null,
          // revert helpers for slow/staggered reverting
          reverting: false,
          revertSpeedMult: 1,
          morphTimer: 0 // timer for random shape shuffling in labil mode
        };
      }
    }
  }

  // Initialize
  initCells();
  initMeshes();

  function initMeshes() {
    // clear group
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }

    meshSquares = new THREE.InstancedMesh(geomSquare, mat, TOTAL);
    meshCircles = new THREE.InstancedMesh(geomCircle, mat, TOTAL);
    meshTriangles = new THREE.InstancedMesh(geomTriangle, mat, TOTAL);

    meshSquares.castShadow = true;
    meshSquares.receiveShadow = true;
    meshCircles.castShadow = true;
    meshCircles.receiveShadow = true;
    meshTriangles.castShadow = true;
    meshTriangles.receiveShadow = true;

    // Hit plane for labil interaction
    const geomHit = new THREE.PlaneGeometry(1, 1);
    const matHit = new THREE.MeshBasicMaterial({ visible: false }); // Invisible
    meshHit = new THREE.Mesh(geomHit, matHit);

    // Allocate color buffers (required for setColorAt in older/standard three.js usage)
    meshSquares.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TOTAL * 3), 3);
    meshCircles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TOTAL * 3), 3);
    meshTriangles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TOTAL * 3), 3);

    // Performance hint
    meshSquares.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    meshCircles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    meshTriangles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    group.add(meshSquares);
    group.add(meshCircles);
    group.add(meshTriangles);
    group.add(meshHit);
  }

  let canvasW = 0, canvasH = 0;
  let tile = 0; // tile size px
  let gridW = 0, gridH = 0, offsetX = 0, offsetY = 0;

  // pointer state
  let mouseX = null;
  let mouseY = null;
  let activationSeed = 0; // increments when pointer moves to mark new activations
  let prevActiveCol = -1; // track previous active column so seed only increments on column change
  let prevActiveRow = -1; // track previous active row so seed only increments on row change
  let isFrozen = false; // freeze state toggle

  function resize() {
    dpr = window.devicePixelRatio || 1;
    // Prefer visualViewport for mobile to handle keyboards/URL bars better
    if (window.visualViewport) {
      canvasW = window.visualViewport.width;
      canvasH = window.visualViewport.height;
    } else {
      canvasW = window.innerWidth;
      canvasH = window.innerHeight;
    }

    renderer.setSize(canvasW, canvasH);
    renderer.setPixelRatio(dpr);

    camera.aspect = canvasW / canvasH;
    camera.updateProjectionMatrix();

    // Fit grid (40x40 units)
    tile = 1;
    gridW = COLS * tile;
    gridH = ROWS * tile;

    // ORTHOGRAPHIC LOGIC - Fit exactly gridW
    const viewSizeW = gridW;
    const viewSizeH = gridW / camera.aspect;

    camera.left = -viewSizeW / 2;
    camera.right = viewSizeW / 2;
    camera.top = viewSizeH / 2;
    camera.bottom = -viewSizeH / 2;

    camera.position.z = 100;
    camera.position.x = 0;
    camera.position.y = -20;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    // Calculate offsets (top-left of the grid in 3D space)
    offsetX = -gridW / 2;
    offsetY = gridH / 2;

    // Update Hit Plane to match Grid Size exactly
    if (meshHit) {
      meshHit.scale.set(gridW, gridH, 1);
      meshHit.position.set(0, 0, 0);
    }
  }

  function randShape() {
    const weights = cfg().shapeWeights;
    const r = Math.random();
    const cumSquare = weights.square;
    const cumCircle = cumSquare + weights.circle;

    if (r < cumSquare) return 'square';
    if (r < cumCircle) return 'circle';
    return 'triangle';
  }

  function randColor() {
    const colors = cfg().colors;
    return colors[Math.floor(Math.random() * colors.length)];
  }

  function onPointerMove(e) {
    const x = (e.clientX !== undefined ? e.clientX : e.touches && e.touches[0].clientX);
    const y = (e.clientY !== undefined ? e.clientY : e.touches && e.touches[0].clientY);

    // NDC: -1 to +1
    pointer.x = (x / window.innerWidth) * 2 - 1;
    pointer.y = -(y / window.innerHeight) * 2 + 1;

    mouseX = x; // Keep for fallback? logic mostly replaced
    mouseY = y;
  }

  window.addEventListener('mousemove', onPointerMove, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchstart', onPointerMove, { passive: true }); // Add touchstart
  window.addEventListener('resize', resize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
  }

  // Button Controls
  const btnLabil = document.getElementById('btnLabil');
  const btnStable = document.getElementById('btnStable');
  const btnFreeze = document.getElementById('btnFreeze');
  const btnReset = document.getElementById('btnReset');

  if (btnLabil) btnLabil.addEventListener('click', (e) => { e.stopPropagation(); setMode('labil'); });
  if (btnStable) btnStable.addEventListener('click', (e) => { e.stopPropagation(); setMode('stable'); });
  if (btnFreeze) btnFreeze.addEventListener('click', (e) => { e.stopPropagation(); toggleFreeze(); });
  if (btnReset) btnReset.addEventListener('click', (e) => { e.stopPropagation(); resetGrid(); });

  function setMode(newMode) {
    if (newMode === 'labil') {
      MODE = 'labil';
      ATTENUATION_DEGS = buildAttenuationDegs();
      HORIZ_RADIUS = ATTENUATION_DEGS.length - 1;
      console.log('Mode: LABIL'); // Fixed log needed to match logic? No, logic was inverted in logs before? 
      // Checking previous logic: if key='1' (Labil), it logged STABLE. Wait.
      // User requested "Mode Name Swapping" in history.
      // Let's check the code:
      // key='1' => MODE='labil'.
      // key='2' => MODE='stable'.

      // Revert logic for 'labil' mode transition:
      const stableIdx = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].modifiedBy === 'stable') stableIdx.push(i);
      }
      stableIdx.sort(() => Math.random() - 0.5);
      const baseDelayL = 0.12;
      const staggerL = 0.06;
      const jitterL = 0.5;
      for (let k = 0; k < stableIdx.length; k++) {
        const idx = stableIdx[k];
        const linear = baseDelayL + k * staggerL;
        const longTail = Math.pow(Math.random(), 2) * 0.9;
        const spread = (Math.random() - 0.5) * jitterL;
        const delay = Math.max(0.02, linear + spread + longTail);
        const cell = cells[idx];
        cell.targetAngle = 0;
        cell.reverting = true;
        cell.revertSpeedMult = 0.25 + Math.random() * 0.35;
        cell.flutterActive = false;
        cell.revertTimer = delay + 0.6 + Math.random() * 0.8;
      }
    } else if (newMode === 'stable') {
      MODE = 'stable';
      ATTENUATION_DEGS = buildAttenuationDegs();
      HORIZ_RADIUS = ATTENUATION_DEGS.length - 1;
      console.log('Mode: STABLE');

      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell.modifiedBy === 'stable') {
          cell.revertTimer = null;
          cell.reverting = false;
          cell.revertSpeedMult = 1;
          cell.flutterActive = true;
          cell.currentIntensity = 1.0;
          if (cell.color === '#ffffff') cell.color = '#3a5eff';
        }
      }
      const labilIdx = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].modifiedBy === 'labil') labilIdx.push(i);
      }
      labilIdx.sort(() => Math.random() - 0.5);
      const baseDelay = 0.06;
      const stagger = 0.04;
      const jitter = 0.35;
      for (let k = 0; k < labilIdx.length; k++) {
        const idx = labilIdx[k];
        const linear = baseDelay + k * stagger;
        const longTail = Math.pow(Math.random(), 2) * 0.6;
        const spread = (Math.random() - 0.5) * jitter;
        const delay = Math.max(0.02, linear + spread + longTail);
        cells[idx].revertTimer = delay;
      }
    }
  }

  function toggleFreeze() {
    isFrozen = !isFrozen;
  }

  function resetGrid() {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      cell.shape = 'square';
      cell.color = '#ffffff';
      cell.pendingShape = null;
      cell.pendingColor = null;
      cell.angle = 0;
      cell.targetAngle = 0;
      cell.zOffset = 0;
      cell.reaction = 0;
      cell.flipped = false;
      cell.flippedMaxAngle = null;
      cell.currentIntensity = 0;
      cell.flutterActive = false;
      cell.revertTimer = null;
      cell.modifiedBy = null;
      cell.reverting = false;
      cell.revertSpeedMult = 1;
      cell.morphTimer = 0;
    }
  }

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    // Mode switching: 1 = labil, 2 = stable
    if (key === '1') {
      setMode('labil');
    }
    if (key === '2') {
      setMode('stable');
    }

    // Freeze toggle: Space
    if (e.code === 'Space' || key === ' ') {
      e.preventDefault(); // Prevent scrolling
      toggleFreeze();
    }

    // Reset: R
    if (key === 'r') {
      resetGrid();
    }
  });

  // main loop
  let lastTime = performance.now();
  let time = 0; // seconds accumulator for flutter
  function loop(t) {
    const dt = Math.min(40, t - lastTime);
    lastTime = t;

    if (!isFrozen) {
      const secs = dt / 1000;
      time += secs;
      update(secs);
    }
    draw();
    requestAnimationFrame(loop);
  }

  function update(delta) {
    let activeCol = -999;
    let activeRow = -999;

    if (!isFrozen && meshHit) {
      raycaster.setFromCamera(pointer, camera);
      // Raycast against the STABLE hit plane
      const intersects = raycaster.intersectObject(meshHit);
      if (intersects.length > 0) {
        // Local point on plane
        const p = intersects[0].point;
        // p.x ranges from -gridW/2 to +gridW/2
        // p.y ranges from -gridH/2 to +gridH/2

        // Convert to col/row
        // col = (x - offsetX) / tile
        // row = (offsetY - y) / tile

        const c = Math.floor((p.x - offsetX) / tile);
        const r = Math.floor((offsetY - p.y) / tile);

        if (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
          activeCol = c;
          activeRow = r;
        }
      }
    }

    if (activeCol !== prevActiveCol || activeRow !== prevActiveRow) {
      prevActiveCol = activeCol;
      prevActiveRow = activeRow;
      activationSeed++;
    }

    const config = cfg();

    // alignment tolerance: fraction of tile. Smaller => need more exact hover.
    // Simplified alignment check for 3D:
    // If we hit a cell with raycaster, we are "near center" enough.
    // Or we could check uv. But for now simpler is better.
    let pointerNearColCenter = (activeCol !== -999);
    let pointerNearRowCenter = (activeRow !== -999);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        const cell = cells[idx];

        const windowSize = 5;
        const half = Math.floor(windowSize / 2);
        let intensity = 0;
        const inVertical = (activeCol >= 0 && activeRow >= 0 && Math.abs(r - activeRow) <= half);
        const horizDist = (activeCol >= 0) ? Math.abs(c - activeCol) : 999;
        const inHorizNear = horizDist <= HORIZ_RADIUS;
        const isMainColumn = (c === activeCol);
        const isMainRow = (r === activeRow);

        if (inVertical && (isMainColumn || inHorizNear)) {
          const vdist = Math.abs(r - activeRow);
          let vFactor = Math.max(0, 1 - (vdist / (half + 1)));
          const hAttenuationDeg = (horizDist <= HORIZ_RADIUS) ? ATTENUATION_DEGS[horizDist] : 0;
          const mainDeg = ATTENUATION_DEGS[0];
          const hFactor = (mainDeg > 0) ? (hAttenuationDeg / mainDeg) : 0;
          intensity = vFactor * hFactor;
          intensity = Math.pow(intensity, 0.9);
        }

        // determine allowed "main activation" depending on mouse alignment
        const mainColumnActivation = isMainColumn && inVertical && (MODE !== 'labil' || pointerNearColCenter);
        const mainRowActivation = isMainRow && inHorizNear && (MODE !== 'labil' || pointerNearRowCenter);

        cell.currentIntensity = intensity;
        cell.flutterActive = intensity > 0.001;

        // In stable mode, all changed forms (not white) get same high intensity for flip & flutter
        // independent from mouse position
        if (MODE === 'stable' && cell.color !== '#ffffff') {
          cell.flutterActive = true;
          cell.currentIntensity = 1.0;
          cell.flutterAmpDeg = 4.0;
          cell.flutterFreq = cell.baseFlutterFreq;
          // If the pointer hovers directly over this cell (column/row activation),
          // drive a stronger flip so already-blue shapes react to the mouse.
          if (mainColumnActivation || mainRowActivation) {
            const fixedMaxDeg = cfg().startDeg;
            const fixedMax = fixedMaxDeg * Math.PI / 180;
            // push targetAngle higher so the cell visibly flips when hovered
            cell.targetAngle = Math.max(cell.targetAngle || 0, 0.6 * fixedMax);
            // give a short reaction pulse so neighbors also respond
            cell.reaction = Math.max(cell.reaction || 0, 0.8);
            cell.currentIntensity = 1.0;
            cell.flutterActive = true;
          }
        }

        // Disable flutter in labil mode
        if (MODE === 'labil') {
          cell.flutterActive = false;
          cell.flutterAmpDeg = 0;
          cell.flutterFreq = 0;
        }

        // Update flutter for stable white cells and labil mode
        if (MODE === 'stable' && cell.color === '#ffffff') {
          cell.flutterAmpDeg = cell.baseFlutterAmpDeg;
          cell.flutterFreq = cell.baseFlutterFreq;
        }

        const localMaxDeg = (horizDist <= HORIZ_RADIUS) ? ATTENUATION_DEGS[horizDist] : 0;
        const localMax = localMaxDeg * Math.PI / 180;

        const baseTarget = cell.flipped ? (cell.flippedMaxAngle || localMax) : 0;

        if (inVertical && isMainColumn) {
          if (!cell.flipped) {
            cell.targetAngle = intensity * localMax;
          } else {
            cell.targetAngle = (cell.flippedMaxAngle || localMax) * (1 - intensity);
          }
        } else if (inVertical && inHorizNear) {
          cell.targetAngle = intensity * localMax;
        } else {
          cell.targetAngle = baseTarget;
        }

        // In stable mode, all changed forms flip independently from mouse, BUT we allow interaction to override
        if (MODE === 'stable' && cell.color !== '#ffffff') {
          const fixedMaxDeg = cfg().startDeg;
          const fixedMax = fixedMaxDeg * Math.PI / 180;
          // Use the greater of: calculated interaction angle OR the base "open" posture (30%)
          cell.targetAngle = Math.max(cell.targetAngle, 0.3 * fixedMax);
        }

        // STABLE: require multiple consecutive activations (debounce) and cooldown
        if (!cell.flipped && (mainColumnActivation || mainRowActivation) && cell.lastActivationSeed !== activationSeed) {
          // record seed for general activation tracking
          cell.lastActivationSeed = activationSeed;
          if (MODE === 'labil') {
            if (cell.labilLastSeed !== activationSeed) {
              cell.labilLastSeed = activationSeed;
              cell.labilActivationCount++;
            }
            if (cell.labilActivationCount >= 2 && cell.cooldown <= 0) {
              cell.pendingShape = randShape();
              cell.pendingColor = randColor();
              cell.labilActivationCount = 0;
              cell.cooldown = 0.6; // 0.6s cooldown to avoid rapid re-flips
            }
          } else {
            // stable/or default behavior
            cell.pendingShape = randShape();
            cell.pendingColor = '#0505fb';
          }
        }

        // tick down cooldown
        cell.cooldown = Math.max(0, (cell.cooldown || 0) - delta);

        // tick down revert timer: when it hits zero, revert to white square
        if (cell.revertTimer != null) {
          cell.revertTimer = Math.max(0, cell.revertTimer - delta);
          if (cell.revertTimer <= 0) {
            cell.color = '#ffffff';
            cell.shape = 'square';
            cell.flipped = false;
            cell.flippedMaxAngle = null;
            cell.revertTimer = null;
            cell.modifiedBy = null;
            cell.reverting = false;
            cell.revertSpeedMult = 1;
            cell.currentIntensity = 0;
            cell.flutterActive = false;
          }
        }

        // STABLE MODE: Continuous shape morphing while active (waiting to revert)
        if (MODE === 'labil' && cell.revertTimer != null) {
          cell.morphTimer -= delta;
          if (cell.morphTimer <= 0) {
            cell.shape = randShape();
            cell.color = randColor();
            cell.morphTimer = 0.4; // shuffle every 400ms (slower)
          }
        }

        // adjust animation speed & reactions for labil mode
        const baseAx = (MODE === 'labil') ? 6 : 12; // slower, smoother in labil
        const speedMult = (cell.reverting && cell.revertSpeedMult) ? cell.revertSpeedMult : 1;
        const ax = baseAx * speedMult;
        const prevAngle = cell.angle;
        cell.angle += (cell.targetAngle - cell.angle) * Math.min(1, ax * delta);

        const MID_ANGLE = localMax * 0.5;
        if (cell.pendingShape && prevAngle < MID_ANGLE && cell.angle >= MID_ANGLE) {
          cell.shape = cell.pendingShape;
          cell.color = cell.pendingColor || cell.color;
          cell.pendingShape = null;
          cell.pendingColor = null;
          cell.flipped = true;
          cell.flippedMaxAngle = localMax;
          // mark which mode created this change
          cell.modifiedBy = MODE;
          // schedule automatic revert back to white square in STABLE mode
          if (MODE === 'labil') {
            // shorter, moderately random reverts (short long-tail)
            const base = 0.8;
            const range = 2.2; // uniform part
            const skew = Math.pow(Math.random(), 2) * 1.0; // small long-tail
            cell.revertTimer = base + Math.random() * range + skew; // ~0.8s - ~4.0s (skewed)
          }

          const intensityForCell = cell.targetAngle / Math.max(1e-6, localMax);
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr;
              const nc = c + dc;
              if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
              const nidx = nr * COLS + nc;
              const dist = Math.hypot(dr, dc);
              const baseAmp = (MODE === 'labil') ? 0.3 : 0.6; // smaller spread in labil
              const amp = (baseAmp * intensityForCell) / Math.max(0.8, dist);
              cells[nidx].reaction = Math.max(cells[nidx].reaction || 0, amp);
            }
          }
        }

        if (cell.flipped && prevAngle > (cell.flippedMaxAngle || localMax) * 0.5 && cell.angle <= (cell.flippedMaxAngle || localMax) * 0.5) {
          cell.flipped = false;
          cell.flippedMaxAngle = null;
        }

        const REACTION_DECAY = (MODE === 'labil') ? 4.0 : 2.8; // faster decay in labil
        cell.targetAngle += (cell.reaction || 0) * localMax;
        cell.reaction = Math.max(0, (cell.reaction || 0) - REACTION_DECAY * delta);

        cell.targetAngle = Math.max(0, Math.min(localMax || MAX_ANGLE, cell.targetAngle));

        const zMult = (MODE === 'labil') ? 0.02 : 0.04;
        cell.zOffset = Math.sin(cell.angle) * (tile * zMult);
      }
    }
  }

  function draw() {
    try {
      // 3D Render
      renderer.render(scene, camera);

      // Sync positions/rotations/colors to InstancedMesh
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          const i = r * COLS + c;
          const cell = cells[i];

          // 1. Calculate position of pivot
          // Pivot is at Left edge of cell.
          const startX = offsetX + c * tile; // Left edge of cell column
          const startY = offsetY - r * tile - tile / 2; // Center Y of cell row (since pivot Y is 0)

          // Position (Pivot):
          const pX = offsetX + c * tile;
          const pY = offsetY - r * tile - tile / 2;
          const pZ = cell.zOffset || 0;

          dummy.position.set(pX, pY, pZ);

          // 2. Rotation
          let flutterRad = 0;
          if (cell.flutterActive) {
            const ampDeg = (cell.flutterAmpDeg || 0) * (cell.currentIntensity || 0);
            flutterRad = ampDeg * Math.PI / 180 * Math.sin(time * (cell.flutterFreq || 1) * 2 * Math.PI + (cell.flutterPhase || 0));
          }
          dummy.rotation.set(0, -(cell.angle + flutterRad), 0);

          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();

          // 3. Set Matrix on the active shape, hide others (scale=0)
          const isSquare = (cell.shape === 'square');
          const isCircle = (cell.shape === 'circle');
          const isTriangle = (cell.shape === 'triangle');

          _color.set(cell.color);

          // Squares
          if (isSquare) {
            meshSquares.setMatrixAt(i, dummy.matrix);
            meshSquares.setColorAt(i, _color);
          } else {
            dummy.scale.set(0, 0, 0);
            dummy.updateMatrix();
            meshSquares.setMatrixAt(i, dummy.matrix);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
          }

          // Circles
          if (isCircle) {
            meshCircles.setMatrixAt(i, dummy.matrix);
            meshCircles.setColorAt(i, _color);
          } else {
            dummy.scale.set(0, 0, 0);
            dummy.updateMatrix();
            meshCircles.setMatrixAt(i, dummy.matrix);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
          }

          // Triangles
          if (isTriangle) {
            meshTriangles.setMatrixAt(i, dummy.matrix);
            meshTriangles.setColorAt(i, _color);
          } else {
            dummy.scale.set(0, 0, 0);
            dummy.updateMatrix();
            meshTriangles.setMatrixAt(i, dummy.matrix);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
          }
        }
      }

      meshSquares.instanceMatrix.needsUpdate = true;
      meshSquares.instanceColor.needsUpdate = true;
      meshCircles.instanceMatrix.needsUpdate = true;
      meshCircles.instanceColor.needsUpdate = true;
      meshTriangles.instanceMatrix.needsUpdate = true;
      meshTriangles.instanceColor.needsUpdate = true;
    } catch (e) {
      console.error(e);
      alert("Error in draw(): " + e.message);
      isFrozen = true; // stop loop
    }
  }




  // Change BG back to normal
  scene.background = new THREE.Color(BG);

  // Ensure resize runs once before loop to set up camera/positions
  resize();
  requestAnimationFrame(loop);
})();