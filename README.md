# Score Following App

A web application for real-time score following. Upload a music score (MusicXML, MEI, or PDF) and follow along as you play, with synchronized highlighting powered by [Matchmaker](https://github.com/pymatchmaker/matchmaker) (ISMIR 2024 Late Breaking Demo).

## Features

- **Real-time score following** with Audio or MIDI input
- **Multiple alignment algorithms**: arzt, dixon, hmm, pthmm, outerhmm, audio_outerhmm
- **Simulation mode**: upload a performance file (audio/MIDI) and play back with pre-computed alignment
- **Score formats**: MusicXML, MEI (via Verovio), PDF (via Audiveris OMR)
- **Visual feedback**: note cursor + measure highlighting

## Pre-requisites

- Python 3.12 (conda recommended)
- Node.js 20+
- FluidSynth and PortAudio (system libraries required by `pyfluidsynth` and `pyaudio`)
- [Audiveris](https://github.com/Audiveris/audiveris) (optional, for PDF score support — download from [releases](https://github.com/Audiveris/audiveris/releases), no separate Java installation needed)

```bash
# macOS
brew install fluidsynth portaudio

# Linux
sudo apt-get install fluidsynth portaudio19-dev
```

## Setup

### Backend

```bash
conda create -n matchmaker-demo python=3.12
conda activate matchmaker-demo
cd backend/
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend/
npm install
```

## Running

```bash
# Start both backend and frontend
./start_app.sh
```

Or start separately:

```bash
# Backend (http://localhost:8000)
cd backend/
conda activate matchmaker-demo
uvicorn app.main:app --reload --port 8000

# Frontend (http://localhost:50003)
cd frontend/
npm start
```

Open http://localhost:50003 in your browser.

> The first startup may take longer as `partitura` downloads required soundfonts.

## Usage

1. **Upload a score** — MusicXML (.xml, .musicxml), MEI (.mei), or PDF (.pdf)
2. **Optionally add a performance file** — audio (.mp3, .wav) or MIDI (.mid) for simulation mode
3. **Select input type and algorithm** — choose Audio/MIDI device and alignment method
4. **Play** — the score cursor follows your performance in real-time

### Simulation mode

Upload a pre-recorded performance file alongside the score to run in simulation mode. Instead of listening to a live input, the app:

1. Runs the selected alignment algorithm offline against the performance file
2. Produces a time-aligned mapping between the audio/MIDI and the score positions
3. Plays back the performance audio with synchronized score highlighting

Select an algorithm and click **Run Simulation** to compute the alignment. Once complete, press **Play** to start playback. The score cursor and measure highlight move in sync with the audio. You can switch algorithms and re-run to compare different alignment results.

## Demo video

<video src="video/demo-video.mp4" controls width="100%"></video>
