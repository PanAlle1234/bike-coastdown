// ── State ──
let recording = false;
let dataPoints = []; // { t, v (m/s), alt (m), lat, lon }
let geoWatchId = null;
let startTime = null;
let timerInterval = null;
let phase = 'waiting'; // waiting | accelerating | coasting | stopped

// ── DOM ──
const $ = id => document.getElementById(id);
const screens = document.querySelectorAll('.screen');

function showScreen(id) {
  screens.forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function setPhase(newPhase, text) {
  phase = newPhase;
  const dot = $('phase-dot');
  dot.className = 'phase-dot ' + newPhase;
  $('phase-text').textContent = text;
}

// ── Slope calculation from GPS altitude + distance ──
function calcSlope(points) {
  if (points.length < 2) return 0;
  const last = points[points.length - 1];
  // Look back ~3 points for smoothing
  const lookback = Math.max(0, points.length - 4);
  const prev = points[lookback];
  if (last.alt == null || prev.alt == null) return 0;

  const dAlt = last.alt - prev.alt;
  const dist = haversine(prev.lat, prev.lon, last.lat, last.lon);
  if (dist < 1) return 0; // need at least 1m
  return (dAlt / dist) * 100; // percent
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── GPS ──
function requestGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('Geolocation not supported in this browser'));
    }
    $('gps-status').textContent = 'Requesting GPS permission…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('gps-status').textContent = 'GPS ready ✓';
        resolve(pos);
      },
      err => {
        let msg = 'Unknown error';
        switch (err.code) {
          case 1: msg = 'Permission denied — tap Allow when prompted'; break;
          case 2: msg = 'Position unavailable — check location services'; break;
          case 3: msg = 'Timeout — GPS took too long'; break;
        }
        $('gps-status').textContent = 'GPS error: ' + msg;
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function beginRecording() {
  dataPoints = [];
  startTime = performance.now();
  recording = true;
  setPhase('waiting', 'Waiting for GPS…');

  const minSpeed = (parseFloat($('min-speed').value) || 5) / 3.6;
  let lastSpeed = 0;
  let coastStartIndex = -1;

  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      if (!recording) return;

      const speed = pos.coords.speed;
      const alt = pos.coords.altitude;
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // Skip if no speed data
      if (speed == null || speed < 0) {
        if (dataPoints.length === 0) {
          setPhase('waiting', 'Waiting for speed data…');
        }
        return;
      }

      const t = (performance.now() - startTime) / 1000;
      dataPoints.push({ t, v: speed, alt, lat, lon });

      // Update live speed
      $('live-speed').textContent = (speed * 3.6).toFixed(1);
      $('samples').textContent = dataPoints.length;

      // Calculate acceleration (smoothed over last few points)
      let accel = 0;
      if (dataPoints.length >= 2) {
        const lookback = Math.max(0, dataPoints.length - 4);
        const prev = dataPoints[lookback];
        const curr = dataPoints[dataPoints.length - 1];
        const dt = curr.t - prev.t;
        if (dt > 0.1) {
          accel = (curr.v - prev.v) / dt;
        }
      }
      $('live-accel').textContent = accel.toFixed(2);
      $('live-accel').style.color = accel >= 0 ? 'var(--orange)' : 'var(--green)';

      // Calculate slope
      const slope = calcSlope(dataPoints);
      $('live-slope').textContent = slope.toFixed(1);
      $('live-slope').style.color = slope > 0.5 ? 'var(--highlight)' : slope < -0.5 ? 'var(--blue)' : 'var(--text)';

      // Altitude
      if (alt != null) {
        $('live-altitude').textContent = alt.toFixed(0);
      }

      // Detect phase
      if (accel > 0.1) {
        setPhase('accelerating', '⚡ Accelerating');
        $('rec-status').textContent = 'Still pedaling — stop to coast';
        coastStartIndex = -1;
      } else if (accel < -0.05 && speed > minSpeed) {
        if (coastStartIndex < 0) coastStartIndex = dataPoints.length - 1;
        setPhase('coasting', '🛞 Coasting');
        $('rec-status').textContent = 'Coasting — recording deceleration';
      } else if (speed < minSpeed && coastStartIndex >= 0) {
        setPhase('stopped', '✓ Done');
        $('rec-status').textContent = 'Speed below cutoff — stopping';
        stopRecording();
        return;
      }

      lastSpeed = speed;
    },
    err => {
      $('rec-status').textContent = 'GPS error: ' + err.message;
      $('rec-status').style.color = 'var(--highlight)';
      setPhase('stopped', 'GPS Error');
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );

  timerInterval = setInterval(() => {
    const elapsed = ((performance.now() - startTime) / 1000) | 0;
    $('elapsed').textContent = elapsed;
  }, 500);
}

function stopRecording() {
  recording = false;
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  if (timerInterval) clearInterval(timerInterval);
  geoWatchId = null;
  timerInterval = null;

  if (dataPoints.length < 5) {
    alert('Not enough data points (' + dataPoints.length + '). Need at least 5.\nMake sure you are moving so GPS reports speed.');
    showScreen('setup-screen');
    return;
  }

  // Find the coasting portion (where speed is consistently decreasing)
  const coastData = findCoastSegment(dataPoints);
  if (coastData.length < 3) {
    alert('Could not detect a clear coasting segment. Try a longer coast.');
    showScreen('setup-screen');
    return;
  }

  analyze(coastData);
  showScreen('results-screen');
}

// Find the longest segment where speed is mostly decreasing
function findCoastSegment(points) {
  let bestStart = 0, bestLen = 0;
  let curStart = 0, curLen = 0;

  for (let i = 1; i < points.length; i++) {
    if (points[i].v <= points[i - 1].v + 0.2) { // allow tiny noise
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = i;
      curLen = 0;
    }
  }

  return points.slice(bestStart, bestStart + bestLen + 1);
}

// ── Physics & Curve Fitting ──
function analyze(coastData) {
  const m = parseFloat($('mass').value) || 80;
  const rho = parseFloat($('air-density').value) || 1.225;
  const g = 9.81;

  // Calculate average slope during coast
  let avgSlope = 0;
  if (coastData.length >= 2 && coastData[0].alt != null && coastData[coastData.length - 1].alt != null) {
    const dAlt = coastData[coastData.length - 1].alt - coastData[0].alt;
    const dist = haversine(
      coastData[0].lat, coastData[0].lon,
      coastData[coastData.length - 1].lat, coastData[coastData.length - 1].lon
    );
    if (dist > 1) avgSlope = dAlt / dist; // as fraction (not percent)
  }

  // Compute acceleration from consecutive points
  // Model: -a = Crr*g*cos(θ) + g*sin(θ) + (rho*CdA/(2*m)) * v²
  // With slope correction: -a - g*sin(θ) = Crr*g*cos(θ) + (rho*CdA/(2*m)) * v²
  const theta = Math.atan(avgSlope);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  const accels = [];
  for (let i = 1; i < coastData.length; i++) {
    const dt = coastData[i].t - coastData[i - 1].t;
    if (dt < 0.05) continue;
    const dv = coastData[i].v - coastData[i - 1].v;
    const a = dv / dt;
    const vMid = (coastData[i].v + coastData[i - 1].v) / 2;
    // Subtract gravity component along slope
    const correctedDecel = -a - g * sinT;
    accels.push({ y: correctedDecel, v2: vMid * vMid });
  }

  if (accels.length < 3) {
    $('res-crr').textContent = 'N/A';
    $('res-cda').textContent = 'N/A';
    return;
  }

  // Linear regression: correctedDecel = A + B*v²
  // A = Crr*g*cos(θ), B = rho*CdA/(2*m)
  let n = accels.length;
  let sumY = 0, sumX = 0, sumXY = 0, sumX2 = 0;
  for (const p of accels) {
    sumY += p.y;
    sumX += p.v2;
    sumXY += p.v2 * p.y;
    sumX2 += p.v2 * p.v2;
  }
  const denom = n * sumX2 - sumX * sumX;
  const A = (sumY * sumX2 - sumX * sumXY) / denom;
  const B = (n * sumXY - sumX * sumY) / denom;

  const Crr = Math.max(0, A / (g * cosT));
  const CdA = Math.max(0, B * 2 * m / rho);

  const duration = coastData[coastData.length - 1].t - coastData[0].t;
  const startSpeed = (coastData[0].v * 3.6).toFixed(1);
  const endSpeed = (coastData[coastData.length - 1].v * 3.6).toFixed(1);

  $('res-crr').textContent = Crr.toFixed(5);
  $('res-cda').textContent = CdA.toFixed(4);
  $('res-duration').textContent = duration.toFixed(1) + 's';
  $('res-speeds').textContent = startSpeed + ' → ' + endSpeed + ' km/h';
  $('res-slope').textContent = (avgSlope * 100).toFixed(1) + '%';

  if (coastData[0].alt != null && coastData[coastData.length - 1].alt != null) {
    const dElev = coastData[coastData.length - 1].alt - coastData[0].alt;
    $('res-elev').textContent = (dElev >= 0 ? '+' : '') + dElev.toFixed(1) + 'm';
  } else {
    $('res-elev').textContent = 'N/A';
  }

  // Save to history (deferred until user names it)
  window._pendingResult = {
    crr: Crr.toFixed(5),
    cda: CdA.toFixed(4),
    duration: duration.toFixed(1),
    speeds: startSpeed + '→' + endSpeed,
    slope: (avgSlope * 100).toFixed(1)
  };

  drawChart(coastData, Crr, CdA, m, rho, theta);
}

// ── Chart ──
function drawChart(coastData, Crr, CdA, m, rho, theta) {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const pad = { top: 20, right: 16, bottom: 36, left: 44 };

  const t0 = coastData[0].t;
  const tMax = coastData[coastData.length - 1].t - t0;
  const vMax = Math.max(...coastData.map(p => p.v)) * 3.6;

  const xScale = t => pad.left + (t / tMax) * (W - pad.left - pad.right);
  const yScale = v => pad.top + (1 - v / (vMax * 1.1)) * (H - pad.top - pad.bottom);

  // Background
  ctx.fillStyle = '#16213e';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#ffffff15';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = yScale((vMax * 1.1 * i) / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }

  // Measured points
  ctx.fillStyle = '#e94560';
  for (const p of coastData) {
    ctx.beginPath();
    ctx.arc(xScale(p.t - t0), yScale(p.v * 3.6), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fitted curve
  const g = 9.81;
  let v = coastData[0].v;
  const dt = 0.1;
  ctx.strokeStyle = '#00c897';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(v * 3.6));
  for (let t = dt; t <= tMax; t += dt) {
    const a = -Crr * g * Math.cos(theta) - g * Math.sin(theta) - (0.5 * rho * CdA * v * v) / m;
    v = Math.max(0, v + a * dt);
    ctx.lineTo(xScale(t), yScale(v * 3.6));
  }
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#8899aa';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Time (s)', W / 2, H - 4);
  ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('Speed (km/h)', 0, 0); ctx.restore();

  // Legend
  ctx.fillStyle = '#e94560';
  ctx.fillRect(W - 110, 8, 10, 10);
  ctx.fillStyle = '#8899aa'; ctx.textAlign = 'left';
  ctx.fillText('Measured', W - 96, 17);
  ctx.fillStyle = '#00c897';
  ctx.fillRect(W - 110, 24, 10, 10);
  ctx.fillStyle = '#8899aa';
  ctx.fillText('Fitted', W - 96, 33);
}

// ── CSV Export ──
function exportCSV() {
  let csv = 'time_s,speed_ms,speed_kmh,altitude_m,latitude,longitude\n';
  for (const p of dataPoints) {
    csv += `${p.t.toFixed(3)},${p.v.toFixed(3)},${(p.v * 3.6).toFixed(2)},${p.alt != null ? p.alt.toFixed(1) : ''},${p.lat.toFixed(6)},${p.lon.toFixed(6)}\n`;
  }
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `coastdown_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Event Wiring ──
$('btn-gps').addEventListener('click', async () => {
  $('gps-status').textContent = 'Requesting GPS…';
  $('gps-status').style.color = 'var(--orange)';
  $('btn-gps').disabled = true;
  $('btn-gps').textContent = '📍 Requesting…';
  try {
    await requestGPS();
    $('btn-gps').textContent = '📍 GPS Ready ✓';
    $('btn-gps').style.background = 'var(--green)';
    $('btn-gps').style.color = '#111';
    $('btn-start').disabled = false;
    $('gps-status').textContent = 'GPS active — you can start when ready.';
    $('gps-status').style.color = 'var(--green)';
  } catch (e) {
    $('btn-gps').disabled = false;
    $('btn-gps').textContent = '📍 Retry GPS';
    $('gps-status').textContent = '❌ ' + e.message;
    $('gps-status').style.color = 'var(--highlight)';
  }
});

$('btn-start').addEventListener('click', () => {
  showScreen('recording-screen');
  beginRecording();
});

$('btn-stop').addEventListener('click', stopRecording);
$('btn-export').addEventListener('click', exportCSV);
$('btn-reset').addEventListener('click', () => {
  $('gps-status').textContent = '';
  showScreen('setup-screen');
});

// Save result with name
$('btn-save-result').addEventListener('click', () => {
  if (!window._pendingResult) return;
  const name = $('res-name').value.trim() || 'Unnamed test';
  const result = {
    ...window._pendingResult,
    name,
    date: new Date().toLocaleString()
  };
  addToHistory(result);
  $('res-name').value = '';
  window._pendingResult = null;
  alert('Saved: ' + name);
});

// ── Power Calculator ──
let pwrCrr = 0, pwrCdA = 0;

function openPowerCalc(crr, cda, source) {
  pwrCrr = parseFloat(crr);
  pwrCdA = parseFloat(cda);
  $('pwr-source').textContent = source;
  $('pwr-crr').textContent = crr;
  $('pwr-cda').textContent = cda + ' m²';
  updatePower();
  showScreen('power-screen');
}

function calcPower(speedKmh, slopePct, windKmh) {
  const m = parseFloat($('mass').value) || 80;
  const rho = parseFloat($('air-density').value) || 1.225;
  const g = 9.81;

  const v = speedKmh / 3.6; // ground speed m/s
  const vWind = windKmh / 3.6; // headwind m/s
  const vAir = v + vWind; // air speed

  const slope = slopePct / 100;
  const theta = Math.atan(slope);

  // Rolling resistance power: Crr * m * g * cos(θ) * v
  const pRoll = pwrCrr * m * g * Math.cos(theta) * v;

  // Aerodynamic drag power: 0.5 * ρ * CdA * vAir² * v
  // (force uses air speed, power = force * ground speed)
  const pAero = 0.5 * rho * pwrCdA * vAir * vAir * v;

  // Gravity power: m * g * sin(θ) * v
  const pGrav = m * g * Math.sin(theta) * v;

  return { pRoll, pAero, pGrav, total: pRoll + pAero + pGrav };
}

function updatePower() {
  const speed = parseFloat($('pwr-speed').value);
  const slope = parseFloat($('pwr-slope').value);
  const wind = parseFloat($('pwr-wind').value);

  $('pwr-speed-val').textContent = speed.toFixed(1) + ' km/h';
  $('pwr-slope-val').textContent = slope.toFixed(1) + ' %';
  $('pwr-wind-val').textContent = wind.toFixed(1) + ' km/h';

  const { pRoll, pAero, pGrav, total } = calcPower(speed, slope, wind);

  $('pwr-watts').textContent = Math.round(Math.max(0, total));
  $('pwr-w-roll').textContent = Math.round(pRoll) + ' W';
  $('pwr-w-aero').textContent = Math.round(pAero) + ' W';
  $('pwr-w-grav').textContent = Math.round(pGrav) + ' W';

  // Bar widths proportional to total
  const maxP = Math.max(1, Math.abs(pRoll) + Math.abs(pAero) + Math.abs(pGrav));
  $('pwr-bar-roll').style.width = Math.round((Math.abs(pRoll) / maxP) * 100) + '%';
  $('pwr-bar-aero').style.width = Math.round((Math.abs(pAero) / maxP) * 100) + '%';
  $('pwr-bar-grav').style.width = Math.round((Math.abs(pGrav) / maxP) * 100) + '%';

  // Color total based on value
  const watts = $('pwr-watts');
  if (total > 300) watts.style.color = 'var(--highlight)';
  else if (total > 150) watts.style.color = 'var(--orange)';
  else watts.style.color = 'var(--green)';
}

$('pwr-speed').addEventListener('input', updatePower);
$('pwr-slope').addEventListener('input', updatePower);
$('pwr-wind').addEventListener('input', updatePower);

$('btn-pwr-back').addEventListener('click', () => {
  showScreen('setup-screen');
});

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Live Watts ──
let lwWatchId = null;
let lwPoints = []; // for slope calculation

function populateProfileSelect() {
  const sel = $('lw-profile');
  const history = loadHistory();
  sel.innerHTML = '';
  if (history.length === 0) {
    sel.innerHTML = '<option value="">No profiles — run a coastdown first</option>';
    return;
  }
  history.forEach((h, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = (h.name || 'Unnamed') + ' (Crr ' + h.crr + ', CdA ' + h.cda + ')';
    sel.appendChild(opt);
  });
  updateLwProfile();
}

function updateLwProfile() {
  const history = loadHistory();
  const idx = parseInt($('lw-profile').value);
  if (isNaN(idx) || !history[idx]) return;
  const h = history[idx];
  $('lw-crr').textContent = h.crr;
  $('lw-cda').textContent = h.cda + ' m²';
}

$('lw-profile').addEventListener('change', updateLwProfile);

$('btn-live-watts').addEventListener('click', async () => {
  const history = loadHistory();
  if (history.length === 0) {
    alert('No coastdown profiles saved yet. Run a coastdown test first.');
    return;
  }

  // Ensure GPS is ready
  try {
    await requestGPS();
  } catch (e) {
    alert('GPS required for live watts.\n' + e.message);
    return;
  }

  populateProfileSelect();
  showScreen('live-watts-screen');
  startLiveWatts();
});

function startLiveWatts() {
  lwPoints = [];
  $('lw-status').textContent = 'Waiting for GPS speed…';
  $('lw-status').style.color = 'var(--green)';

  lwWatchId = navigator.geolocation.watchPosition(
    pos => {
      const speed = pos.coords.speed;
      const alt = pos.coords.altitude;
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      if (speed == null || speed < 0) return;

      lwPoints.push({ alt, lat, lon });
      // Keep last 10 points for slope
      if (lwPoints.length > 10) lwPoints.shift();

      const speedKmh = speed * 3.6;
      $('lw-speed').textContent = speedKmh.toFixed(1);
      if (alt != null) $('lw-alt').textContent = alt.toFixed(0);

      // Calculate slope from recent points
      let slopePct = 0;
      if (lwPoints.length >= 2) {
        const first = lwPoints[0];
        const last = lwPoints[lwPoints.length - 1];
        if (first.alt != null && last.alt != null) {
          const dist = haversine(first.lat, first.lon, last.lat, last.lon);
          if (dist > 2) {
            slopePct = ((last.alt - first.alt) / dist) * 100;
          }
        }
      }
      $('lw-slope').textContent = slopePct.toFixed(1);
      $('lw-slope').style.color = slopePct > 0.5 ? 'var(--highlight)' : slopePct < -0.5 ? 'var(--blue)' : 'var(--text)';

      // Get selected profile
      const history = loadHistory();
      const idx = parseInt($('lw-profile').value);
      if (isNaN(idx) || !history[idx]) return;
      const profile = history[idx];

      const m = parseFloat($('mass').value) || 80;
      const rho = parseFloat($('air-density').value) || 1.225;
      const g = 9.81;
      const Crr = parseFloat(profile.crr);
      const CdA = parseFloat(profile.cda);

      const v = speed; // m/s
      const slope = slopePct / 100;
      const theta = Math.atan(slope);

      const pRoll = Crr * m * g * Math.cos(theta) * v;
      const pAero = 0.5 * rho * CdA * v * v * v;
      const pGrav = m * g * Math.sin(theta) * v;
      const total = pRoll + pAero + pGrav;

      $('lw-watts').textContent = Math.round(Math.max(0, total));
      $('lw-w-roll').textContent = Math.round(pRoll) + ' W';
      $('lw-w-aero').textContent = Math.round(pAero) + ' W';
      $('lw-w-grav').textContent = Math.round(pGrav) + ' W';

      const maxP = Math.max(1, Math.abs(pRoll) + Math.abs(pAero) + Math.abs(pGrav));
      $('lw-bar-roll').style.width = Math.round((Math.abs(pRoll) / maxP) * 100) + '%';
      $('lw-bar-aero').style.width = Math.round((Math.abs(pAero) / maxP) * 100) + '%';
      $('lw-bar-grav').style.width = Math.round((Math.abs(pGrav) / maxP) * 100) + '%';

      // Color watts
      const el = $('lw-watts');
      if (total > 300) el.style.color = 'var(--highlight)';
      else if (total > 150) el.style.color = 'var(--orange)';
      else el.style.color = 'var(--green)';

      $('lw-status').textContent = 'Live — updating';
    },
    err => {
      $('lw-status').textContent = 'GPS error: ' + err.message;
      $('lw-status').style.color = 'var(--highlight)';
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function stopLiveWatts() {
  if (lwWatchId != null) navigator.geolocation.clearWatch(lwWatchId);
  lwWatchId = null;
  showScreen('setup-screen');
}

$('btn-lw-stop').addEventListener('click', stopLiveWatts);

// ── History (localStorage) ──
const HISTORY_KEY = 'coastdown_history';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch { return []; }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function addToHistory(result) {
  const history = loadHistory();
  history.unshift(result);
  // Keep last 50 entries
  if (history.length > 50) history.length = 50;
  saveHistory(history);
  renderHistory();
}

function deleteFromHistory(index) {
  const history = loadHistory();
  history.splice(index, 1);
  saveHistory(history);
  renderHistory();
}

function renderHistory() {
  const history = loadHistory();
  const card = $('history-card');
  const list = $('history-list');

  if (history.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.innerHTML = history.map((h, i) => `
    <div class="history-entry">
      <div>
        <div class="history-name">${h.name || 'Unnamed'}</div>
        <div class="history-date">${h.date}</div>
        <div class="history-values">Crr ${h.crr} · CdA ${h.cda} m²</div>
      </div>
      <div>
        <div class="history-meta">${h.speeds} km/h<br>${h.duration}s · ${h.slope}% slope</div>
        <button class="history-pwr" data-index="${i}" aria-label="Power calculator" title="Power Calc">⚡</button>
        <button class="history-delete" data-index="${i}" aria-label="Delete entry">×</button>
      </div>
    </div>
  `).join('');

  // Wire delete buttons
  list.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteFromHistory(parseInt(btn.dataset.index));
    });
  });

  // Wire power calc buttons
  list.querySelectorAll('.history-pwr').forEach(btn => {
    btn.addEventListener('click', () => {
      const h = history[parseInt(btn.dataset.index)];
      openPowerCalc(h.crr, h.cda, h.name || h.date);
    });
  });
}

$('btn-clear-history').addEventListener('click', () => {
  if (confirm('Delete all saved tests?')) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }
});

// Load history on startup
renderHistory();
