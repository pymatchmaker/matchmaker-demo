import asyncio
import queue
import shutil
import threading
import uuid
from typing import Optional
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import partitura

warnings.filterwarnings("ignore", module="partitura")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
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
    run_websocket_score_following,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    upload_dir = Path("./uploads")
    upload_dir.mkdir(exist_ok=True)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
        "audio": ["arzt", "dixon", "outerhmm", "skf"],
        "midi": ["slt_oltw", "arzt", "dixon", "hmm", "pthmm", "outerhmm"],
    }


@app.post("/upload")
def upload_file(
    file: UploadFile = File(...),
    performance_file: UploadFile = File(None),
    tempo: Optional[str] = Form(None),
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

    user_tempo = float(tempo) if tempo else None
    preprocess_result = preprocess_score(file_path, file_id=file_id, user_tempo=user_tempo)

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
    import math

    def sanitize(obj):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        if isinstance(obj, dict):
            return {k: sanitize(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [sanitize(v) for v in obj]
        return obj

    return {"alignment": sanitize(alignment)}


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
                    f"[{datetime.now().strftime('%H:%M:%S.%f')}] Current position: {current_position:.2f}"
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


@app.websocket("/ws/audio-stream")
async def websocket_audio_stream_endpoint(websocket: WebSocket):
    global _active_stop_event

    # Cancel any previous score following session
    if _active_stop_event is not None:
        _active_stop_event.set()

    position_manager.reset()
    await websocket.accept()

    # Receive initial configuration message
    data = await websocket.receive_json()
    file_id = data.get("file_id")
    method = data.get("method", "arzt")
    input_type = data.get("input_type", "audio")
    print(f"Stream received config: {data}")

    stop_event = threading.Event()
    _active_stop_event = stop_event
    ready_event = threading.Event()
    data_queue = queue.Queue()

    # Run WebSocket score following in a separate thread
    loop = asyncio.get_event_loop()
    task = loop.run_in_executor(
        executor,
        run_websocket_score_following,
        file_id,
        method,
        data_queue,
        input_type,
        stop_event,
        ready_event,
    )

    async def wait_for_ready():
        """Wait for the matchmaker to finish initialization, then notify the client."""
        while not ready_event.is_set():
            await asyncio.sleep(0.1)
            if task.done():
                return
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json({"status": "ready"})
                print(f"Matchmaker ready, notified client for {file_id}")
        except Exception as e:
            print(f"Error sending ready status: {e}")

    async def receive_data():
        """Receive audio/MIDI data from the WebSocket and feed it into the queue."""
        frame_count = 0
        try:
            while websocket.client_state == WebSocketState.CONNECTED:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if "bytes" in message and message["bytes"]:
                    data_queue.put(message["bytes"])
                    frame_count += 1
                    if frame_count == 1:
                        await websocket.send_json({"status": "stream_started"})
                        print(f"Audio stream started for {file_id}")
                    if frame_count % 500 == 0:
                        print(f"Received {frame_count} frames for {file_id}")
                elif "text" in message and message.get("text"):
                    import json as json_mod

                    try:
                        msg_data = json_mod.loads(message["text"])
                        if msg_data.get("type") == "midi":
                            status = msg_data["status"]
                            msg_type = status & 0xF0
                            midi_msg = {
                                "type": "note_on" if msg_type == 0x90 else "note_off",
                                "note": msg_data["note"],
                                "velocity": msg_data["velocity"],
                                "time": msg_data.get("time", 0),
                            }
                            data_queue.put(midi_msg)
                            frame_count += 1
                            if frame_count == 1:
                                await websocket.send_json({"status": "stream_started"})
                                print(f"MIDI stream started for {file_id}")
                            if frame_count % 100 == 0:
                                print(
                                    f"Received {frame_count} MIDI messages for {file_id}"
                                )
                    except (json_mod.JSONDecodeError, KeyError):
                        pass
        except Exception as e:
            print(f"Receive error: {e}")
        finally:
            print(f"Receive ended: {frame_count} total frames for {file_id}")
            data_queue.put(None)

    async def send_positions():
        """Poll position_manager and send updates to the client."""
        prev_position = 0
        try:
            while websocket.client_state == WebSocketState.CONNECTED:
                current_position = position_manager.get_position(file_id)
                if current_position != prev_position:
                    print(
                        f"[{datetime.now().strftime('%H:%M:%S.%f')}] Audio stream position: {current_position:.2f}"
                    )
                    import time as _time

                    await websocket.send_json(
                        {
                            "beat_position": current_position,
                            "server_ts": _time.time() * 1000,
                        }
                    )
                    prev_position = current_position
                await asyncio.sleep(0.01)

                if task.done():
                    try:
                        await websocket.send_json({"status": "completed"})
                    except Exception:
                        pass
                    break
        except Exception as e:
            print(f"Position send error: {e}")

    try:
        # Fire-and-forget: notify client when matchmaker is ready
        asyncio.create_task(wait_for_ready())
        receive_task = asyncio.create_task(receive_data())
        send_task = asyncio.create_task(send_positions())
        # Wait for either task to finish (receive ends on disconnect, send ends on completion)
        done, pending = await asyncio.wait(
            [receive_task, send_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
    except Exception as e:
        print(f"Audio stream websocket error: {e}")
    finally:
        stop_event.set()
        data_queue.put(None)
        _active_stop_event = None
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except RuntimeError:
            pass
        position_manager.reset()
