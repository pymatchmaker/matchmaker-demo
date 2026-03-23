import asyncio
import shutil
import threading
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import partitura

warnings.filterwarnings("ignore", module="partitura")

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState

from .position_manager import position_manager
from .utils import (
    find_performance_file_by_id,
    find_score_file_by_id,
    get_audio_devices,
    get_midi_devices,
    preprocess_score,
    run_precomputed_alignment,
    run_score_following,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    upload_dir = Path("./uploads")
    upload_dir.mkdir(exist_ok=True)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:50003", "http://127.0.0.1:50003"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
executor = ThreadPoolExecutor(max_workers=2)
# Track active stop_event so new sessions can cancel previous ones
_active_stop_event: threading.Event | None = None


# ================== API ==================
@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.post("/reset")
async def reset_uploads():
    """Clear all uploaded files."""
    upload_dir = Path("./uploads")
    if upload_dir.exists():
        for f in upload_dir.iterdir():
            if f.is_file():
                f.unlink()
    return {"status": "ok"}


@app.get("/audio-devices")
async def audio_devices():
    devices = get_audio_devices()
    return {"devices": devices}


@app.get("/midi-devices")
async def midi_devices():
    devices = get_midi_devices()
    return {"devices": devices}


@app.get("/methods")
async def methods():
    return {
        "audio": ["arzt", "dixon", "audio_outerhmm"],
        "midi": ["arzt", "dixon", "hmm", "pthmm", "outerhmm"],
    }


@app.post("/upload")
def upload_file(
    file: UploadFile = File(...), performance_file: UploadFile = File(None)
):
    file_id = str(uuid.uuid4())[:8]
    upload_dir = Path("./uploads")
    upload_dir.mkdir(exist_ok=True)

    # Save score file
    file_path = upload_dir / f"{file_id}_{file.filename}"
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Save performance file if provided
    if performance_file:
        performance_path = (
            upload_dir / f"{file_id}_performance_{performance_file.filename}"
        )
        with open(performance_path, "wb") as buffer:
            shutil.copyfileobj(performance_file.file, buffer)
        print(f"Performance file saved: {performance_path}")

        # Convert MIDI performance to WAV for browser playback
        if performance_path.suffix.lower() in [".mid", ".midi"]:
            perf_wav_path = upload_dir / f"{file_id}_performance_audio.wav"
            try:
                perf_score = partitura.load_score(str(performance_path))
                partitura.save_wav_fluidsynth(perf_score, str(perf_wav_path), bpm=120)
                print(f"Converted MIDI performance to WAV: {perf_wav_path}")
            except Exception as e:
                print(f"MIDI to WAV conversion failed: {e}")

    preprocess_result = preprocess_score(file_path, file_id=file_id)

    result: dict = {"file_id": file_id}

    if isinstance(preprocess_result, dict) and preprocess_result.get("type") == "pdf":
        result["is_pdf"] = True
        if preprocess_result.get("pixel_mapping"):
            result["pixel_mapping"] = preprocess_result["pixel_mapping"]
    elif isinstance(preprocess_result, Path) and preprocess_result.exists():
        result["musicxml_content"] = preprocess_result.read_text(encoding="utf-8")

    return result


@app.get("/score/{file_id}/image")
async def get_score_image(file_id: str):
    png_path = Path("./uploads") / f"{file_id}_score.png"
    if not png_path.exists():
        raise HTTPException(status_code=404, detail="Score image not found")
    return FileResponse(str(png_path), media_type="image/png")


@app.get("/score/{file_id}/pixel-mapping")
async def get_pixel_mapping(file_id: str):
    import json as json_mod
    mapping_path = Path("./uploads") / f"{file_id}_pixel_mapping.json"
    if not mapping_path.exists():
        raise HTTPException(status_code=404, detail="Pixel mapping not found")
    return json_mod.loads(mapping_path.read_text())


@app.post("/score/{file_id}/alignment")
def compute_alignment(file_id: str, method: str = "audio_outerhmm"):
    """Run alignment on-demand with the specified method (runs in threadpool)."""
    alignment = run_precomputed_alignment(file_id, method=method)
    if alignment is None:
        raise HTTPException(status_code=400, detail="Alignment failed")
    return {"alignment": alignment}


@app.get("/score/{file_id}")
async def get_score(file_id: str):
    """Return score file content and metadata for a given file_id."""
    upload_dir = Path("./uploads")
    score_file = None

    # Find the original score file (xml/mei/musicxml only, not binary midi)
    if upload_dir.exists():
        for f in upload_dir.iterdir():
            if (
                f.is_file()
                and f.stem.startswith(file_id)
                and f.suffix in [".xml", ".mei", ".musicxml"]
            ):
                score_file = f
                break

    if not score_file:
        raise HTTPException(status_code=404, detail="Score not found")

    content = score_file.read_text(encoding="utf-8")
    has_performance = find_performance_file_by_id(file_id) is not None

    return {
        "file_id": file_id,
        "file_name": score_file.name.removeprefix(f"{file_id}_"),
        "file_content": content,
        "has_performance_file": has_performance,
    }


@app.get("/score/{file_id}/performance")
async def get_performance(file_id: str):
    """Return the performance audio file (MIDI files are served as converted WAV)."""
    # Prefer converted WAV for MIDI performance files
    perf_wav = Path("./uploads") / f"{file_id}_performance_audio.wav"
    if perf_wav.exists():
        return FileResponse(str(perf_wav))

    perf_file = find_performance_file_by_id(file_id)
    if not perf_file:
        raise HTTPException(status_code=404, detail="Performance file not found")
    return FileResponse(str(perf_file))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global _active_stop_event

    # Cancel any previous score following session
    if _active_stop_event is not None:
        _active_stop_event.set()

    position_manager.reset()
    await websocket.accept()

    data = await websocket.receive_json()
    file_id = data.get("file_id")
    input_type = data.get("input_type", "audio")
    device = data.get("device")
    method = data.get("method", "audio_outerhmm")
    print(f"Received data: {data}")

    stop_event = threading.Event()
    _active_stop_event = stop_event

    # Run score following in a separate thread
    loop = asyncio.get_event_loop()
    task = loop.run_in_executor(
        executor, run_score_following, file_id, input_type, device, method, stop_event
    )

    try:
        prev_position = 0
        while websocket.client_state == WebSocketState.CONNECTED:
            current_position = position_manager.get_position(file_id)
            if current_position != prev_position:
                print(
                    f"[{datetime.now().strftime('%H:%M:%S.%f')}] Current position: {current_position}"
                )
                await websocket.send_json({"beat_position": current_position})
                prev_position = current_position
            await asyncio.sleep(0.1)

            if task.done():
                try:
                    await websocket.send_json({"status": "completed"})
                except Exception:
                    pass
                break

    except Exception as e:
        print(f"Websocket error: {e}")
    finally:
        stop_event.set()
        _active_stop_event = None
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except RuntimeError:
            pass
        position_manager.reset()
