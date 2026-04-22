# PiVault NAS — Setup Guide

## Project Structure

```
pivault/
├── server.js          ← Express backend (all API routes)
├── package.json       ← Dependencies
├── storage/           ← Auto-created: all your NAS files live here
└── public/
    └── index.html     ← The dashboard UI
```

---

## Windows Setup (Development)

### 1. Install Node.js
Download from https://nodejs.org (LTS version)
Verify: open PowerShell and run:
```
node --version
npm --version
```

### 2. Install dependencies
```powershell
cd C:\path\to\pivault
npm install
```

### 3. Start the server
```powershell
node server.js
```

You'll see:
```
╔══════════════════════════════════════╗
║       PiVault NAS Server v1.0        ║
╠══════════════════════════════════════╣
║  Local:   http://localhost:8080      ║
║  Network: http://192.168.x.x:8080   ║
╚══════════════════════════════════════╝
```

### 4. Open the dashboard
Go to http://localhost:8080 in your browser.

Default credentials:
- admin / admin123  (full access)
- john  / john123   (read + write)
- sara  / sara123   (read only)

### 5. Change the storage folder (optional)
By default files are stored in ./storage/ next to server.js.
To change it, set an environment variable before starting:
```powershell
$env:STORAGE_ROOT = "D:\MyNASFiles"
node server.js
```

---

## Raspberry Pi Deployment

### 1. Copy the project to the Pi
From your Windows machine:
```powershell
scp -r C:\path\to\pivault pi@192.168.1.100:~/pivault
```
Or use a USB drive.

### 2. SSH into the Pi
```bash
ssh pi@192.168.1.100
```

### 3. Install Node.js on the Pi
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 4. Mount your external drive (if using one)
```bash
sudo mkdir -p /media/pi/NAS
sudo mount /dev/sda1 /media/pi/NAS
```

### 5. Start the server
```bash
cd ~/pivault
npm install
STORAGE_ROOT=/media/pi/NAS node server.js
```

### 6. Auto-start on boot with systemd
Create a service file:
```bash
sudo nano /etc/systemd/system/pivault.service
```

Paste this:
```ini
[Unit]
Description=PiVault NAS Server
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/pivault/server.js
WorkingDirectory=/home/pi/pivault
Environment=STORAGE_ROOT=/media/pi/NAS
Environment=PORT=8080
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable pivault
sudo systemctl start pivault
sudo systemctl status pivault
```

Now PiVault starts automatically on every boot.
Access it from any device on your WiFi at: http://192.168.1.100:8080

---

## Motion-triggered Recording (IR sensor + USB webcam)

PiVault can optionally watch a GPIO pin (IR motion sensor) and, on movement, record a **10-second** clip from a USB webcam into NAS storage.

### 1) Install FFmpeg on Raspberry Pi
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

### 2) Wire your PIR/IR sensor
- VCC → 5V (or 3.3V depending on module)
- GND → GND
- OUT → GPIO17 (default in config below)

### 3) Start PiVault with motion env vars
```bash
cd ~/pivault
npm install
MOTION_RECORDING_ENABLED=1 \
MOTION_GPIO_PIN=17 \
MOTION_GPIO_SYSFS_PIN= \
MOTION_RECORD_SECONDS=5 \
MOTION_CAMERA_DEVICE=/dev/video0 \
MOTION_OUTPUT_DIR=camera-events \
STORAGE_ROOT=/media/pi/NAS \
node server.js
```

Recordings will appear in:
`/media/pi/NAS/camera-events/`

### 4) Optional systemd env vars
Add these to your `pivault.service`:
```ini
Environment=MOTION_RECORDING_ENABLED=1
Environment=MOTION_GPIO_PIN=17
Environment=MOTION_GPIO_SYSFS_PIN=
Environment=MOTION_RECORD_SECONDS=5
Environment=MOTION_CAMERA_DEVICE=/dev/video0
Environment=MOTION_OUTPUT_DIR=camera-events
```

> Note: GPIO access usually requires running on the host OS or a privileged container with GPIO devices mounted.

---

## Docker mode (recommended if you do not run Node on host)

If Docker is running Node for you, use this flow instead of installing Node/npm on the Pi host.

### 1) Start container with hardware routed in
`docker-compose.yml` is already configured for:
- USB camera: `/dev/video0`
- GPIO: `/sys/class/gpio`, `/dev/gpiomem`, `/dev/gpiochip0`
- FFmpeg inside container image

Run:
```bash
cd ~/pivault
MOTION_RECORDING_ENABLED=1 \
MOTION_GPIO_PIN=17 \
MOTION_GPIO_SYSFS_PIN= \
MOTION_RECORD_SECONDS=5 \
MQ2_ENABLED=1 \
MQ2_GPIO_PIN=21 \
MQ2_ACTIVE_HIGH=0 \
BUZZER_GPIO_PIN=22 \
BUZZER_ACTIVE_HIGH=0 \
docker compose up -d --build
```

### 2) Verify logs
```bash
docker compose logs -f pivault
```

Look for:
- `🎯 Motion recording enabled ...`
- `🧪 MQ-2 monitoring enabled ...`
- `📹 Motion detected. Recording started ...`
- `✅ Motion recording saved ...`
- `🚨 MQ-2 threshold crossed. Buzzer ON.`

Recordings will be at:
`./storage/camera-events/`

### 3) MQ-2 + buzzer wiring
- MQ-2 `D0` → GPIO21
- Buzzer `SIG` → GPIO22
- Shared `GND` with Raspberry Pi
- MQ-2 `VCC` per module requirements

When MQ-2 crosses threshold (digital `D0` active), PiVault turns buzzer on and shows live MQ-2 status on the dashboard.

Most MQ-2 modules expose `D0` as **LOW when gas is detected**, so default config uses:
`MQ2_ACTIVE_HIGH=0`

Many buzzer modules are also active-LOW, so default config uses:
`BUZZER_ACTIVE_HIGH=0`

If your buzzer still behaves inverted, set:
`BUZZER_ACTIVE_HIGH=1`

---

## API Reference

| Method | Endpoint              | Description                          |
|--------|-----------------------|--------------------------------------|
| POST   | /api/login            | Authenticate, returns session token  |
| POST   | /api/logout           | Invalidate session                   |
| GET    | /api/files?path=      | List directory contents              |
| POST   | /api/upload?path=     | Upload files (multipart/form-data)   |
| GET    | /api/download?path=   | Download a file                      |
| POST   | /api/folder           | Create a new folder                  |
| DELETE | /api/delete           | Delete a file or folder (admin only) |
| POST   | /api/rename           | Rename a file or folder              |
| GET    | /api/stats            | Disk, CPU, RAM, network info         |
| GET    | /api/activity         | Last 50 file operations              |
| GET    | /api/health           | Server health check                  |

All endpoints except /api/login and /api/health require the header:
`x-session-token: <token from login>`

---

## Changing Passwords / Adding Users

Edit the USERS object at the top of server.js:
```js
const USERS = {
  admin: { password: 'your-strong-password', role: 'admin' },
  alice: { password: 'alice-pass', role: 'user' },
  bob:   { password: 'bob-pass',   role: 'readonly' },
};
```

Roles:
- admin     → full access (upload, download, delete, rename, create folders)
- user      → upload, download, rename, create folders (no delete)
- readonly  → download only

---

## Troubleshooting

**"Cannot reach server"** — make sure node server.js is running and check firewall:
```powershell
# Windows: allow port 8080
netsh advfirewall firewall add rule name="PiVault" protocol=TCP dir=in localport=8080 action=allow
```

**Upload fails** — check that the storage folder exists and is writable.

**Can't access from other devices** — use the Network URL shown at startup (not localhost).

**Docker keeps restarting with `ENOENT ... /app/server.key`** — this means your container is running an older image/config that expects TLS key files. Rebuild cleanly and recreate:
```bash
cd ~/pivault
docker compose down --remove-orphans
docker compose build --no-cache
docker compose up -d
docker compose logs -f pivault
```

If it still shows `/app/server.key`, verify you are in the correct repo folder and check what code is inside the running container:
```bash
docker compose exec pivault sh -lc 'pwd && ls -la /app && sed -n "1,420p" /app/server.js | tail -n 80'
```

**Motion setup failed with `EINVAL` while exporting GPIO** — on newer Raspberry Pi kernels, sysfs GPIO numbers may be offset (for example base + BCM pin). Keep `MOTION_GPIO_PIN=17` and set the mapped sysfs number explicitly:
```bash
MOTION_GPIO_SYSFS_PIN=529 docker compose up -d --build
```
(529 is a common mapping for BCM17 on some Pi kernels.)

**Motion never triggers** — your PIR output polarity may be inverted. Try:
```bash
MOTION_GPIO_ACTIVE_HIGH=0 docker compose up -d --build
```

**Need GPIO debug logs** — print raw GPIO value transitions and trigger-ignore reasons:
```bash
MOTION_DEBUG_GPIO=1 docker compose up -d --build
docker compose logs -f pivault
```
