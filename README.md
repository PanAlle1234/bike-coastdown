# 🚴 Bike Coastdown PWA

Measure rolling resistance (Crr) and aerodynamic drag area (CdA) from a coast-down test — right from your phone's browser.

## How It Works

1. Enter your total mass (rider + bike) and air density
2. Get up to speed on a flat road
3. Tap **Start**, stop pedaling, and coast
4. The app records GPS speed vs. time
5. Auto-stops when you drop below the min speed cutoff
6. Fits the deceleration curve to extract **Crr** and **CdA**

## Physics

The coast-down deceleration model:

```
dv/dt = -Crr·g - (ρ·CdA·v²) / (2·m)
```

Linear regression on measured deceleration vs. v² separates the constant (rolling resistance) and velocity-dependent (aero drag) terms.

## Running Locally

Serve the files with any static server (service worker requires HTTPS or localhost):

```bash
npx serve .
```

Then open `http://localhost:3000` on your phone (same network) or use the local URL.

## Install on iPhone

1. Open the URL in Safari
2. Tap the Share button → "Add to Home Screen"
3. It runs as a standalone app with offline support

## Export

Tap **Export CSV** after a test to download the raw speed-vs-time data.
