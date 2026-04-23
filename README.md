# Matchmaker Demo App

A web application for real-time score following powered by [Matchmaker](https://github.com/pymatchmaker/matchmaker). Upload a music score (MusicXML, MEI, or PDF) and follow along as you play, with synchronized visual highlighting in the browser.

## Features

- **Real-time score following** via browser audio (Web Audio API) or MIDI input
- **Multiple alignment algorithms**
  - Audio: arzt, dixon, outerhmm, skf
  - MIDI: arzt, dixon, hmm, pthmm, outerhmm, SLT_OLTW, SL_OLTW, OTM, OPTM
- **PDF score support** via Audiveris OMR — includes a direct `.omr` parser that bypasses MusicXML export for more accurate note extraction
- **Simulation mode**: upload a performance file (audio/MIDI) and play back with pre-computed alignment
- **Score formats**: MusicXML, MEI (via Verovio), PDF (via Audiveris)
- **Visual feedback**: measure highlighting + note cursor (toggleable in settings)
- **Tempo control**: auto-detected from score markings or manually set on upload

## Quick start (Docker)

The easiest way to run the app — no Python/Node setup required.

**Pre-requisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/laurenceyoon/matchmaker-demo.git
cd matchmaker-demo
docker compose up
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

> The first run will pull the images from Docker Hub (~1–2 GB). Subsequent starts are instant.

---

## Pre-requisites (manual setup)

- Python 3.12 (conda recommended)
- Node.js 20+
- FluidSynth system library (required by `pyfluidsynth` for score audio synthesis) — PortAudio is only needed if you plan to use local audio devices instead of browser microphone input
- [Audiveris](https://github.com/Audiveris/audiveris) (optional, for PDF score support — download from [releases](https://github.com/Audiveris/audiveris/releases), no separate Java installation needed)

```bash
# macOS
brew install fluidsynth   # add portaudio only if using local audio devices

# Linux (or via conda: conda install -c conda-forge fluidsynth)
sudo apt-get install fluidsynth
```

## Setup

### Backend

```bash
conda create -n matchmaker-demo python=3.12
conda activate matchmaker-demo
```

Install [Matchmaker](https://github.com/pymatchmaker/matchmaker) from source into this env following its README (the `[devices]` extra is optional — browser microphone mode works without it). Then install the demo's own deps:

```bash
cd backend/
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend/
npm install
```

### Audiveris (optional, for PDF scores)

Download and extract a release from the [Audiveris releases page](https://github.com/Audiveris/audiveris/releases), then point the backend to it:

```bash
export AUDIVERIS_HOME=~/opt/audiveris     # path to the extracted distribution
# or
export AUDIVERIS_CMD=/path/to/Audiveris   # explicit executable
```

No configuration is needed if `audiveris` is on your `PATH`, installed at `/opt/audiveris`, or (macOS) installed to `/Applications/Audiveris.app`.

### Environment variables (optional)

If you need to override defaults — e.g. the ports are taken or you're exposing the app under a different hostname — copy `.env.example` to `.env` and edit.

## Running

```bash
# Start both backend and frontend
./start_app.sh
```

Or start separately:

```bash
# Backend
cd backend/
conda activate matchmaker-demo
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (server.js adds the /api + /ws proxy that the app expects)
cd frontend/
BACKEND_INTERNAL_URL=http://localhost:8000 NEXT_PUBLIC_BACKEND_URL=/api node server.js
```

> The first startup may take longer as `partitura` downloads required soundfonts.

## Usage

1. **Upload a score** — MusicXML (.xml, .musicxml), MEI (.mei), or PDF (.pdf)
2. **Optionally set tempo** — enter quarter-note BPM if auto-detection is inaccurate
3. **Optionally add a performance file** — audio (.mp3, .wav) or MIDI (.mid) for simulation mode
4. **Select input type and algorithm** — choose Audio/MIDI and alignment method
5. **Play** — the score cursor follows your performance in real-time

### Live mode

Select Audio or MIDI input, choose an alignment method, and press Play. The app captures audio from your browser microphone (via Web Audio API) or MIDI from a connected device, streams it to the backend over WebSocket, and displays real-time score position updates.

### Simulation mode

Upload a pre-recorded performance file alongside the score. Select an algorithm and click **Run** to compute the alignment offline. Once complete, press **Play** to start playback with synchronized score highlighting.

### Display settings

Click the gear icon (top-right) on the score page to toggle:
- **Note pointer** — green vertical cursor on the current note
- **Measure highlight** — blue highlight on the current measure

## Architecture

```
Browser (Frontend)
├── Upload form (score + optional performance + tempo)
├── Score rendering: OSMD (MusicXML), Verovio (MEI), ImageRenderer (PDF)
├── Web Audio API → PCM capture → WebSocket stream
└── Real-time highlight updates for score display

Server (Backend)
├── FastAPI endpoints (upload, score, alignment, WebSocket)
├── Audiveris OMR pipeline (PDF → .omr → MIDI + pixel mapping)
├── Direct .omr parser (bypasses MusicXML export)
└── Matchmaker score following (audio/MIDI alignment) 
```

## Demo video

<!-- <video src="video/demo-video.mp4" controls width="100%"></video> -->
