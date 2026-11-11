# DemiDoF — Ray-Ban Display rotation simulator

Meta Ray-Ban Display puts a small monocular screen in the right lens: roughly 20° field of view,
600 × 600 pixels, fixed in the lower-right of your vision. Whatever an app draws is glued to your head
(0 DoF). The hardware never asks *where* the display sits relative to your gaze or the world.

**DemiDoF** is a browser-based simulator that explores what happens when software gives that
head-locked window *half* a degree of freedom: content is anchored in the world (or tethered to it)
and the display becomes a 20° peephole you steer with your head. It also lets you move, tilt and resize
the display itself, so you can study placement — the thing the product skipped.

![modes](docs/modes.png)

## What you get

| Layer | What it shows |
| --- | --- |
| **Wearer's view** | A first-person scene with the virtual display overlaid at its real angular size and placement. Black is transparent, like a waveguide. |
| **Device frame** | The exact 600 × 600 frame the glasses would receive, bottom-left. Save it as PNG. |
| **Anchoring modes** | `1` Head-locked (stock) · `2` World-locked (DemiDoF) · `3` Lazy follow (dead-zone + spring) · `4` Horizon-level (roll cancelled) |
| **Content presets** | Wide workspace (cards across 120°, only one fits at a time) · HUD demo (clock, notification, nav) · Angular test grid |
| **Placement controls** | FOV, horizontal / vertical offset, roll, perceived distance, brightness, occlusion, eyebox falloff |
| **Head input** | Mouse / touch drag, arrow keys, `Q`/`E` roll, phone gyroscope, scripted demo motion |
| **Camera passthrough** | Phone or webcam feed as the background: hold the phone up like a viewfinder with gyro on |
| **WebXR** | On a Quest, the display is rendered into the **right eye only**, in passthrough AR, at the same angular size — the most faithful preview short of the glasses |

## Run

No build step. Three.js is vendored; everything is plain ES modules.

```
python serve.py            # http://localhost:8000
python serve.py --https    # https://<lan-ip>:8443 — needed for phone gyro, camera and Quest WebXR
```

`--https` creates a self-signed certificate in `.cert/` using the `openssl` that ships with Git for
Windows. Accept the certificate warning once on the phone / headset.

## Controls

| Input | Action |
| --- | --- |
| drag / arrows | look around |
| `Q` `E` | roll head |
| `1` – `4` | anchoring mode |
| `C` | recenter content in the display |
| `R` | reset head (with gyro: make the current heading forward) |
| `H` | hide / show the panel |
| XR controller trigger / pinch | recenter content |

## How it works

```
head quaternion ──×── placement offset ──► display camera (fov 20°, 1:1)
                                               │ renders content scene
                                               ▼
            content anchor ◄── mode ──   600×600 render target ──► overlay quad (child of eye camera)
                                                                 ──► device-frame preview / PNG
```

* `src/display.js` — `DisplayModel`: the display camera, the render target, the anchoring logic and the
  additive overlay shader.
* `src/content.js` — widgets placed by azimuth / elevation / angular size on a sphere, drawn with Canvas 2D.
* `src/head.js` — pointer, keyboard, DeviceOrientation and demo motion → head quaternion.
* `src/world.js` — procedural room: gradient sky, graded ground grid, compass ring every 15°, landmarks.
* `src/xr.js` — WebXR session; the overlay is put on layer 2 so only the right eye sees it.
* `src/glasses.js`, `src/glasses-head.js` — the on-device Web App (`glasses.html`): IMU head input with
  selectable sensor-frame corrections, arrow-key menu, direct 600 × 600 render.
* `src/main.js` — frame loop: head → display → content → render target → wearer view → preview.

Anchoring modes, in terms of the content anchor `A` and the display camera `D`:

| Mode | Rule |
| --- | --- |
| Head-locked | `A = D` every frame |
| World-locked | `A` fixed; `C` / mode switch sets `A = D` |
| Lazy follow | when `angle(A, D) > deadzone`, slerp `A → D` with rate `speed`; stop when < 0.15° |
| Horizon-level | `A = yaw/pitch of D`, roll = 0 |

## Assumptions

* 600 × 600 px and ~20° FOV are the widely reported specs. The default placement (+12° right, −8° down)
  and the perceived focal distance are estimates — adjust the sliders to match what you see in your glasses.
* The overlay treats bright pixels as slightly occluding (`Occlusion` slider) because a bright waveguide
  image reads as more opaque than pure addition suggests. Set it to 0 for pure additive.
* Everything is monocular; the simulator shows one eye. In WebXR the "Right eye only" toggle reproduces
  the monocular effect.

## On the glasses: the Web App build

`glasses.html` is DemiDoF running **on the Ray-Ban Display itself**, as a Meta Web App (plain HTML +
JavaScript at a public HTTPS URL, added to the glasses in Developer Mode). The page *is* the
600 × 600 display: no wearer's view, no room, no sliders. The content layer is rendered straight to
the canvas through the display camera, the head pose comes from the glasses' IMU through
`DeviceOrientationEvent`, and a six-button bar is driven with the arrows + Select that the glasses
deliver.

| Button | What it does |
| --- | --- |
| **Mode** | cycles World-locked → Head-locked → Lazy follow → Horizon-level |
| **Content** | cycles Cards (workspace across 120°) → HUD → angular Grid |
| **Recenter** | the way you are looking becomes "forward" and the content is centred in the display |
| **Head** | Sensor (IMU) → Demo motion (scripted) → Drag (Neural Band / pointer only) |
| **Axes** | cycles six sensor-frame corrections (see below) |
| **Readout** | overlays mode, head yaw / pitch / roll, content offset and fps |

`←` `→` move between buttons, Select activates, `↑` hides the bar, `↓` or any arrow brings it back.
Black pixels are transparent on the waveguide, so the frame is drawn on pure black. Settings persist
in `localStorage`. If the sensor permission is refused, hangs, or delivers no events (desktop, Meta's
simulator), the app falls back to demo motion after a few seconds and the **Head** button switches back.

**Sensor axes.** The W3C orientation frame is defined for a phone screen; Meta's docs don't say how
the sensor sits inside the glasses. The default (*Upright, screen faces wearer*) is the frame of a phone
held in front of your face. If turning your head left/right pitches the content instead, press **Axes**
until yaw, pitch and roll respond correctly, then **Recenter**. Turn on **Readout** to see the numbers.

### Testing without the glasses

1. `python serve.py` and open `http://localhost:8000/glasses.html` in a desktop browser. Arrows + Enter
   drive the bar; drag the canvas to look around in *Drag* mode; `1`–`4` and `C` are desktop shortcuts.
2. Install Meta's **Ray-Ban Display Simulator** Chrome extension (Chrome Web Store, id
   `jpjlmmodokemlepklkdbimceggpbjcll`) and turn it on over the page. It frames the 600 × 600 viewport,
   sends arrow / Select key events, overlays backgrounds and runs a quality checklist. It does not
   simulate the IMU, so the page shows demo motion.
3. `npm test` loads `glasses.html` headlessly, feeds it synthetic IMU events, drives the bar with the
   keyboard and checks that a 20° head turn produces a 20° content offset.

### Running it on the Ray-Ban Display

Requirements: glasses firmware **v125+**, Meta AI app **v272+**, and the page on a **public HTTPS URL**
(HTTP and self-signed certificates are rejected). The repo is static, so GitHub Pages works as-is:
enable Pages for the `master` branch and the build is at
`https://<user>.github.io/RayBanDisplay-DemiDoF/glasses.html`. A tunnel such as `cloudflared tunnel --url
http://localhost:8000` also gives a temporary HTTPS URL.

1. In the Meta AI app go to **Settings → App Info** and tap the **App version** number five times, then
   **Enable** Developer Mode (once).
2. **App Settings → Apps → Web Apps → Connect Web App**, enter the URL of `glasses.html` and **Save**.
   Or scan the install QR that the simulator's *View on Glasses QR* generates; it encodes
   `fb-viewapp://web_app_deep_link?appName=DemiDoF&appUrl=<https-url>`.
3. The app appears at the end of the app grid on the glasses, marked *unverified*. Launch it, press
   Select on **Start** and accept the sensor permission.
4. Look straight ahead and press **Recenter**. Turn your head: in World-locked mode the cards stay put
   and the display sweeps across them; in Head-locked mode they follow you (stock behaviour).
5. Middle-tap opens the Web App menu (Restart, Resume, Permissions). **Record Display** in the Meta AI
   app captures what the display shows.

Not yet verified on hardware: WebGL performance of Three.js in the glasses browser and the sensor-frame
mapping. Both are the first things to check; the **Readout** and **Axes** buttons exist for that.

## Dev checks

```
npm install && npx playwright install chromium
npm test        # headless render of every mode/preset + the glasses build → test-output/*.png
node tools/make-icons.mjs   # regenerate assets/icon-96.png / icon-180.png from favicon.svg
```

## Roadmap

* Verify the glasses build on hardware: frame rate, sensor-frame mapping, drift of the IMU yaw.
* Record head-motion traces and replay them to compare modes side by side.
* Comfort metrics: how often content leaves the window, time-to-recenter, roll error.
