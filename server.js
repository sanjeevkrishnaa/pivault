/**
 * PiVault NAS — Express Backend v1.1
 * Fixes: download auth via query token, range requests for video/audio seek
 * New:   /api/preview endpoint for inline browser media viewing
 */

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { exec }   = require('child_process');
const { spawn }  = require('child_process');

const app  = express();
const PORT = process.env.PORT || 8080;

const STORAGE_ROOT = process.env.STORAGE_ROOT
  || path.join(__dirname, 'storage');

const USERS = {
  admin: { password: 'admin123', role: 'admin' },
};

const sessions    = {};
const activityLog = [];

// ─── MOTION RECORDING (IR SENSOR + USB WEBCAM) ──────
const MOTION_ENABLED = process.env.MOTION_RECORDING_ENABLED === '1';
const MOTION_GPIO_PIN = parseInt(process.env.MOTION_GPIO_PIN || '17', 10);
const MOTION_GPIO_SYSFS_PIN = process.env.MOTION_GPIO_SYSFS_PIN
  ? parseInt(process.env.MOTION_GPIO_SYSFS_PIN, 10)
  : null;
const MOTION_GPIO_ACTIVE_HIGH = process.env.MOTION_GPIO_ACTIVE_HIGH !== '0';
const MOTION_DEBUG_GPIO = process.env.MOTION_DEBUG_GPIO === '1';
const MOTION_RECORD_SECONDS = parseInt(process.env.MOTION_RECORD_SECONDS || '5', 10);
const MOTION_CAMERA_DEVICE = process.env.MOTION_CAMERA_DEVICE || '/dev/video0';
const MOTION_OUTPUT_DIR = process.env.MOTION_OUTPUT_DIR || 'camera-events';
const MOTION_FFMPEG_BIN = process.env.MOTION_FFMPEG_BIN || 'ffmpeg';
const MQ2_ENABLED = process.env.MQ2_ENABLED === '1';
const MQ2_GPIO_PIN = parseInt(process.env.MQ2_GPIO_PIN || '21', 10);
const MQ2_GPIO_SYSFS_PIN = process.env.MQ2_GPIO_SYSFS_PIN
  ? parseInt(process.env.MQ2_GPIO_SYSFS_PIN, 10)
  : null;
const MQ2_ACTIVE_HIGH = process.env.MQ2_ACTIVE_HIGH === '1';
const BUZZER_GPIO_PIN = parseInt(process.env.BUZZER_GPIO_PIN || '22', 10);
const BUZZER_GPIO_SYSFS_PIN = process.env.BUZZER_GPIO_SYSFS_PIN
  ? parseInt(process.env.BUZZER_GPIO_SYSFS_PIN, 10)
  : null;
const BUZZER_ACTIVE_HIGH = process.env.BUZZER_ACTIVE_HIGH !== '0';

const motionState = {
  recording: false,
  lastTriggerAt: 0,
};

const mq2State = {
  enabled: MQ2_ENABLED,
  gasDetected: false,
  buzzerOn: false,
  inputValue: null,
  lastChangedAt: null,
  inputSysfsPin: null,
  buzzerSysfsPin: null,
  error: null,
};

function setupMotionRecording() {
  if (!MOTION_ENABLED) return;

  const gpioNumber = resolveSysfsGpioNumber(MOTION_GPIO_PIN, MOTION_GPIO_SYSFS_PIN);
  const gpioPath = `/sys/class/gpio/gpio${gpioNumber}`;
  const valuePath = path.join(gpioPath, 'value');
  const edgePath = path.join(gpioPath, 'edge');
  const directionPath = path.join(gpioPath, 'direction');

  try {
    if (!fs.existsSync(gpioPath)) {
      fs.writeFileSync('/sys/class/gpio/export', String(gpioNumber));
    }

    fs.writeFileSync(directionPath, 'in');
    // Capture either transition and let MOTION_GPIO_ACTIVE_HIGH decide
    // whether 1 or 0 means "motion active" for this sensor module.
    fs.writeFileSync(edgePath, 'both');
  } catch (err) {
    console.error(`❌ Motion setup failed on GPIO ${MOTION_GPIO_PIN} (sysfs:${gpioNumber}): ${err.message}`);
    console.error('   Tip: run on host or privileged container with GPIO access.');
    return;
  }

  let polling = false;
  let lastValue = null;
  const onChange = () => {
    if (polling) return;
    polling = true;
    fs.readFile(valuePath, 'utf8', (err, data) => {
      polling = false;
      if (err) return;
      const value = data.trim();
      if (value === lastValue) return;
      lastValue = value;

      const isActive = MOTION_GPIO_ACTIVE_HIGH ? value === '1' : value === '0';
      if (MOTION_DEBUG_GPIO) {
        console.log(`🧪 GPIO state changed: value=${value} active=${isActive ? 'yes' : 'no'}`);
      }
      if (isActive) handleMotionTrigger();
    });
  };

  // Sysfs GPIO "value" files do not consistently emit watch events across kernels,
  // so use explicit polling for reliable motion detection.
  setInterval(onChange, 100);
  onChange();
  console.log(`🎯 Motion recording enabled (GPIO ${MOTION_GPIO_PIN} / sysfs ${gpioNumber} → ${MOTION_CAMERA_DEVICE}, ${MOTION_RECORD_SECONDS}s clips).`);
}

function resolveSysfsGpioNumber(bcmPin, explicitSysfsPin) {
  if (Number.isInteger(explicitSysfsPin)) return explicitSysfsPin;
  if (!Number.isInteger(bcmPin) || bcmPin < 0) throw new Error(`Invalid GPIO pin: ${bcmPin}`);

  try {
    const gpioRoot = '/sys/class/gpio';
    const chips = fs.readdirSync(gpioRoot).filter(n => /^gpiochip\d+$/.test(n));

    let best = null;
    for (const chip of chips) {
      const chipDir = path.join(gpioRoot, chip);
      const base = parseInt(fs.readFileSync(path.join(chipDir, 'base'), 'utf8').trim(), 10);
      const ngpio = parseInt(fs.readFileSync(path.join(chipDir, 'ngpio'), 'utf8').trim(), 10);
      const labelPath = path.join(chipDir, 'label');
      const label = fs.existsSync(labelPath) ? fs.readFileSync(labelPath, 'utf8').trim().toLowerCase() : '';

      if (!Number.isFinite(base) || !Number.isFinite(ngpio)) continue;
      if (bcmPin >= ngpio) continue;

      // Prefer the BCM controller when labels are available (newer Raspberry Pi kernels).
      const score = label.includes('bcm') || label.includes('pinctrl') ? 2 : 1;
      if (!best || score > best.score) best = { score, mapped: base + bcmPin };
    }

    if (best) return best.mapped;
  } catch {
    // Fallback to legacy direct numbering below.
  }

  // Legacy sysfs on older kernels often maps BCM pin directly.
  return bcmPin;
}

function handleMotionTrigger() {
  const now = Date.now();
  if (motionState.recording) {
    if (MOTION_DEBUG_GPIO) console.log('🧪 Trigger ignored: recording already in progress.');
    return;
  }
  if (now - motionState.lastTriggerAt < 1500) {
    if (MOTION_DEBUG_GPIO) console.log('🧪 Trigger ignored: debounce window active.');
    return;
  }
  motionState.lastTriggerAt = now;

  const eventDir = safePath(MOTION_OUTPUT_DIR);
  if (!fs.existsSync(eventDir)) fs.mkdirSync(eventDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(eventDir, `motion-${stamp}.mp4`);

  const args = [
    '-y',
    '-f', 'v4l2',
    '-i', MOTION_CAMERA_DEVICE,
    '-t', String(MOTION_RECORD_SECONDS),
    '-vcodec', 'libx264',
    '-pix_fmt', 'yuv420p',
    outFile,
  ];

  motionState.recording = true;
  logActivity('motion-start', path.relative(STORAGE_ROOT, outFile), null, 'sensor');
  console.log(`📹 Motion detected. Recording started: ${outFile}`);

  const rec = spawn(MOTION_FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  rec.stderr.on('data', () => {});

  rec.on('close', code => {
    motionState.recording = false;
    if (code === 0 && fs.existsSync(outFile)) {
      const size = fs.statSync(outFile).size;
      const relPath = path.relative(STORAGE_ROOT, outFile);
      logActivity('motion-recording', relPath, size, 'sensor');
      console.log(`✅ Motion recording saved: ${relPath} (${formatBytes(size)})`);
    } else {
      logActivity('motion-failed', path.relative(STORAGE_ROOT, outFile), null, 'sensor');
      console.error(`❌ Motion recording failed with code ${code}`);
    }
  });

  rec.on('error', err => {
    motionState.recording = false;
    logActivity('motion-error', path.relative(STORAGE_ROOT, outFile), null, 'sensor');
    console.error(`❌ Could not start ffmpeg: ${err.message}`);
  });
}

function setupMq2Monitoring() {
  if (!MQ2_ENABLED) return;

  const mq2SysfsPin = resolveSysfsGpioNumber(MQ2_GPIO_PIN, MQ2_GPIO_SYSFS_PIN);
  const buzzerSysfsPin = resolveSysfsGpioNumber(BUZZER_GPIO_PIN, BUZZER_GPIO_SYSFS_PIN);
  mq2State.inputSysfsPin = mq2SysfsPin;
  mq2State.buzzerSysfsPin = buzzerSysfsPin;

  const mq2Path = `/sys/class/gpio/gpio${mq2SysfsPin}`;
  const buzzerPath = `/sys/class/gpio/gpio${buzzerSysfsPin}`;
  const mq2ValuePath = path.join(mq2Path, 'value');
  const mq2DirectionPath = path.join(mq2Path, 'direction');
  const mq2EdgePath = path.join(mq2Path, 'edge');
  const buzzerValuePath = path.join(buzzerPath, 'value');
  const buzzerDirectionPath = path.join(buzzerPath, 'direction');

  try {
    if (!fs.existsSync(mq2Path)) fs.writeFileSync('/sys/class/gpio/export', String(mq2SysfsPin));
    if (!fs.existsSync(buzzerPath)) fs.writeFileSync('/sys/class/gpio/export', String(buzzerSysfsPin));

    fs.writeFileSync(mq2DirectionPath, 'in');
    fs.writeFileSync(mq2EdgePath, 'both');
    fs.writeFileSync(buzzerDirectionPath, 'out');
    fs.writeFileSync(buzzerValuePath, BUZZER_ACTIVE_HIGH ? '0' : '1');
  } catch (err) {
    mq2State.error = err.message;
    console.error(`❌ MQ-2 setup failed (MQ2 GPIO ${MQ2_GPIO_PIN}, buzzer GPIO ${BUZZER_GPIO_PIN}): ${err.message}`);
    return;
  }

  const setBuzzer = (on) => {
    try {
      fs.writeFileSync(buzzerValuePath, on ? (BUZZER_ACTIVE_HIGH ? '1' : '0') : (BUZZER_ACTIVE_HIGH ? '0' : '1'));
      mq2State.buzzerOn = on;
    } catch (err) {
      mq2State.error = err.message;
      console.error(`❌ Failed to write buzzer GPIO: ${err.message}`);
    }
  };

  const poll = () => {
    fs.readFile(mq2ValuePath, 'utf8', (err, raw) => {
      if (err) return;
      const value = raw.trim();
      if (value !== '0' && value !== '1') return;
      if (value === mq2State.inputValue) return;

      mq2State.inputValue = value;
      mq2State.lastChangedAt = new Date().toISOString();
      const isActive = MQ2_ACTIVE_HIGH ? value === '1' : value === '0';
      mq2State.gasDetected = isActive;
      setBuzzer(isActive);

      if (isActive) {
        logActivity('mq2-alert', `MQ-2 gas threshold crossed (GPIO ${MQ2_GPIO_PIN})`, null, 'sensor');
        console.log('🚨 MQ-2 threshold crossed. Buzzer ON.');
      } else {
        logActivity('mq2-clear', `MQ-2 returned to normal (GPIO ${MQ2_GPIO_PIN})`, null, 'sensor');
        console.log('✅ MQ-2 normal. Buzzer OFF.');
      }
    });
  };

  setInterval(poll, 150);
  poll();
  console.log(`🧪 MQ-2 monitoring enabled (GPIO ${MQ2_GPIO_PIN}/sysfs ${mq2SysfsPin}) with buzzer GPIO ${BUZZER_GPIO_PIN}/sysfs ${buzzerSysfsPin}.`);
}

// ─── MIDDLEWARE ───────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  console.log(`📁 Created storage root: ${STORAGE_ROOT}`);
}

// ─── AUTH ─────────────────────────────────────────────
// Standard auth — checks header only
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  req.user = sessions[token];
  next();
}

// Flexible auth — checks header OR query param
// Required for <a href>, <img src>, <video src> which cannot set headers
function requireAuthFlex(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.token;
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  req.user = sessions[token];
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}

// ─── HELPERS ─────────────────────────────────────────
function safePath(userPath) {
  const relative = userPath ? userPath.replace(/^\/+/, '') : '';
  const resolved = path.resolve(STORAGE_ROOT, relative);
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT))) {
    throw new Error('Path traversal attempt blocked.');
  }
  return resolved;
}

function logActivity(action, name, size, user) {
  activityLog.unshift({ action, name, size: size ? formatBytes(size) : null, user: user || 'system', time: new Date().toISOString() });
  if (activityLog.length > 50) activityLog.pop();
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileType(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.pdf':'doc','.doc':'doc','.docx':'doc','.txt':'doc','.pptx':'doc','.xlsx':'doc','.md':'doc',
    '.mp4':'vid','.mkv':'vid','.avi':'vid','.mov':'vid','.webm':'vid',
    '.jpg':'img','.jpeg':'img','.png':'img','.gif':'img','.webp':'img','.svg':'img',
    '.zip':'zip','.tar':'zip','.gz':'zip','.rar':'zip','.7z':'zip',
    '.js':'code','.py':'code','.sh':'code','.ts':'code','.json':'code','.html':'code','.css':'code',
    '.mp3':'audio','.wav':'audio','.flac':'audio','.ogg':'audio','.m4a':'audio',
  };
  return map[ext] || 'other';
}

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.gif':  'image/gif',
  '.webp':'image/webp', '.svg':  'image/svg+xml',
  '.mp4': 'video/mp4',  '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav':  'audio/wav',
  '.ogg': 'audio/ogg',  '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.txt': 'text/plain', '.md':   'text/plain',
  '.js':  'text/javascript', '.json': 'application/json',
  '.html':'text/html',  '.css':  'text/css',
};

function formatUptime(s) {
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return `${d}d ${h}h ${m}m`;
}

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const d of iface) {
      if (d.family === 'IPv4' && !d.internal) return d.address;
    }
  }
  return '0.0.0.0';
}

// ─── AUTH ROUTES ──────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = require('crypto').randomBytes(24).toString('hex');
  sessions[token] = { username, role: user.role };
  logActivity('login', username, null, username);
  console.log(`✅ Login: ${username} (${user.role})`);
  res.json({ token, username, role: user.role });
});

app.post('/api/logout', requireAuth, (req, res) => {
  logActivity('logout', req.user.username, null, req.user.username);
  delete sessions[req.headers['x-session-token']];
  res.json({ message: 'Logged out.' });
});

// ─── FILE ROUTES ──────────────────────────────────────
app.get('/api/files', requireAuth, (req, res) => {
  try {
    const dir = safePath(req.query.path || '');
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Path not found.' });
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'Not a directory.' });

    const entries = fs.readdirSync(dir).map(name => {
      try {
        const full = path.join(dir, name);
        const s    = fs.statSync(full);
        const isDir = s.isDirectory();
        const type  = getFileType(name, isDir);
        const ext   = path.extname(name).toLowerCase();
        return {
          name, type, isDirectory: isDir,
          size: isDir ? null : s.size,
          sizeFormatted: isDir ? '—' : formatBytes(s.size),
          modified: s.mtime.toISOString(),
          modifiedFormatted: s.mtime.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }),
          permissions: (isDir ? 'd' : '-') + (s.mode & 0o777).toString(8),
          path: req.query.path ? (req.query.path + '/' + name).replace(/^\//, '') : name,
          previewable: ['img','vid','audio','doc'].includes(type) && !!MIME_TYPES[ext],
          mime: MIME_TYPES[ext] || 'application/octet-stream',
        };
      } catch { return null; }
    }).filter(Boolean);

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: req.query.path || '/', entries, count: entries.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// UPLOAD
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dest = safePath(req.query.path || '');
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (err) { cb(err); }
  },
  filename: (req, file, cb) => {
    // Decode UTF-8 filename that multer might have mangled
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe    = decoded.replace(/[<>:"/\\|?*]/g, '_');
    cb(null, safe);
  },
});

const upload = multer({ storage: multerStorage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.post('/api/upload', requireAuth, upload.array('files'), (req, res) => {
  if (req.user.role === 'readonly') return res.status(403).json({ error: 'Read-only users cannot upload.' });
  const uploaded = req.files.map(f => {
    logActivity('upload', f.originalname, f.size, req.user.username);
    console.log(`⬆  Upload: ${f.filename} (${formatBytes(f.size)})`);
    return { name: f.filename, size: f.size, sizeFormatted: formatBytes(f.size) };
  });
  res.json({ uploaded, count: uploaded.length });
});

// DOWNLOAD + PREVIEW (unified endpoint)
// token accepted via query param so <a href>, <video src>, <img src> all work
app.get('/api/download', requireAuthFlex, (req, res) => {
  try {
    const filePath = safePath(req.query.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a directory.' });

    const filename = path.basename(filePath);
    const ext      = path.extname(filename).toLowerCase();
    const mime     = MIME_TYPES[ext] || 'application/octet-stream';
    const inline   = req.query.preview === '1';

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`);

    logActivity(inline ? 'preview' : 'download', filename, stat.size, req.user.username);

    // Range request support — essential for video/audio seeking
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 10 * 1024 * 1024, stat.size - 1);
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range',  `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// CREATE folder
app.post('/api/folder', requireAuth, (req, res) => {
  if (req.user.role === 'readonly') return res.status(403).json({ error: 'Read-only users cannot create folders.' });
  try {
    const folderPath = safePath(req.body.path);
    if (fs.existsSync(folderPath)) return res.status(409).json({ error: 'Folder already exists.' });
    fs.mkdirSync(folderPath, { recursive: true });
    logActivity('mkdir', req.body.path, null, req.user.username);
    res.json({ created: req.body.path });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE
app.delete('/api/delete', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  try {
    const target = safePath(req.body.path);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found.' });
    fs.statSync(target).isDirectory()
      ? fs.rmSync(target, { recursive: true, force: true })
      : fs.unlinkSync(target);
    logActivity('delete', req.body.path, null, req.user.username);
    console.log(`🗑  Delete: ${req.body.path}`);
    res.json({ deleted: req.body.path });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// RENAME
app.post('/api/rename', requireAuth, (req, res) => {
  if (req.user.role === 'readonly') return res.status(403).json({ error: 'Read-only users cannot rename.' });
  try {
    const oldPath = safePath(req.body.oldPath);
    const newPath = safePath(req.body.newPath);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Source not found.' });
    if (fs.existsSync(newPath))  return res.status(409).json({ error: 'Destination exists.' });
    fs.renameSync(oldPath, newPath);
    logActivity('rename', `${req.body.oldPath} → ${req.body.newPath}`, null, req.user.username);
    res.json({ renamed: req.body.newPath });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── STATS ────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const getDisk = () => new Promise(resolve => {
    const isWin = os.platform() === 'win32';
    const drive = isWin ? STORAGE_ROOT.split(path.sep)[0] : '/';
    const cmd   = isWin
      ? `wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /format:csv`
      : `df -k "${drive}"`;

    exec(cmd, (err, stdout) => {
      if (err) return resolve({ total: null, free: null, used: null });
      try {
        if (isWin) {
          const lines = stdout.trim().split('\n').filter(l => l.includes(','));
          const parts = lines[lines.length-1].split(',');
          const free  = parseInt(parts[1]); const total = parseInt(parts[2]);
          resolve({ total, free, used: total - free });
        } else {
          const parts = stdout.trim().split('\n')[1].split(/\s+/);
          resolve({ total: parseInt(parts[1])*1024, used: parseInt(parts[2])*1024, free: parseInt(parts[3])*1024 });
        }
      } catch { resolve({ total: null, free: null, used: null }); }
    });
  });

  const getCpu = () => new Promise(resolve => {
    const s = os.cpus().map(c => c.times);
    setTimeout(() => {
      const e = os.cpus().map(c => c.times);
      const pcts = s.map((st, i) => {
        const et = e[i];
        const idle  = et.idle - st.idle;
        const total = Object.values(et).reduce((a,b)=>a+b,0) - Object.values(st).reduce((a,b)=>a+b,0);
        return 100 * (1 - idle / total);
      });
      resolve(Math.round(pcts.reduce((a,b)=>a+b,0) / pcts.length));
    }, 200);
  });

  Promise.all([getDisk(), getCpu()]).then(([disk, cpu]) => {
    const totalMem = os.totalmem(), freeMem = os.freemem();
    let fileCount = 0;
    try { fileCount = fs.readdirSync(STORAGE_ROOT).length; } catch {}
    res.json({
      disk: {
        total: disk.total, used: disk.used, free: disk.free,
        totalFormatted: disk.total ? formatBytes(disk.total) : 'N/A',
        usedFormatted:  disk.used  ? formatBytes(disk.used)  : 'N/A',
        freeFormatted:  disk.free  ? formatBytes(disk.free)  : 'N/A',
        percentUsed:    disk.total ? Math.round((disk.used/disk.total)*100) : 0,
      },
      memory: {
        total: totalMem, used: totalMem-freeMem, free: freeMem,
        totalFormatted: formatBytes(totalMem), usedFormatted: formatBytes(totalMem-freeMem),
        percentUsed: Math.round(((totalMem-freeMem)/totalMem)*100),
      },
      cpu: { percent: cpu, cores: os.cpus().length, model: os.cpus()[0]?.model || 'Unknown' },
      system: {
        platform: os.platform(), hostname: os.hostname(),
        uptime: os.uptime(), uptimeFormatted: formatUptime(os.uptime()),
        nodeVersion: process.version, arch: os.arch(),
      },
      storage: { root: STORAGE_ROOT, fileCount },
      mq2: {
        enabled: mq2State.enabled,
        gasDetected: mq2State.gasDetected,
        buzzerOn: mq2State.buzzerOn,
        inputValue: mq2State.inputValue,
        lastChangedAt: mq2State.lastChangedAt,
        inputSysfsPin: mq2State.inputSysfsPin,
        buzzerSysfsPin: mq2State.buzzerSysfsPin,
        error: mq2State.error,
      },
      activeUsers: Object.values(sessions).map(s => s.username),
    });
  });
});

app.get('/api/activity', requireAuth, (req, res) => res.json({ activity: activityLog }));
app.get('/api/health',   (req, res) => res.json({ status: 'ok', version: '1.1.0', timestamp: new Date().toISOString() }));

// ─── START ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        PiVault NAS Server v1.1           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}           ║`);
  console.log(`║  Network: http://${ip.padEnd(15)}:${PORT}   ║`);
  console.log(`║  Storage: ${STORAGE_ROOT.slice(0,30).padEnd(30)} ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  setupMotionRecording();
  setupMq2Monitoring();
});
