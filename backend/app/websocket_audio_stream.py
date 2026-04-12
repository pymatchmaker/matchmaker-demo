"""
WebSocket Audio Stream

A Stream subclass that receives raw PCM audio data from an external queue
(fed by a WebSocket handler) instead of PyAudio.
"""

import queue
import time
from types import TracebackType
from typing import Callable, Optional, Type, Union

import numpy as np

from matchmaker.io.queue import RECVQueue
from matchmaker.io.stream import STREAM_END, Stream

QUEUE_TIMEOUT = 30


class WebSocketAudioStream(Stream):
    """A Stream that reads raw PCM audio from a queue populated by a WebSocket handler.

    Parameters
    ----------
    processor : Callable
        Feature extraction callable (e.g., ChromagramProcessor).
    sample_rate : int
        Sample rate of the incoming audio.
    hop_length : int
        Hop length used for feature extraction.
    data_queue : queue.Queue
        Queue where the WebSocket handler puts raw PCM bytes (float32)
        or None as a disconnect sentinel.
    """

    def __init__(
        self,
        processor: Callable,
        sample_rate: int,
        hop_length: int,
        data_queue: queue.Queue,
    ) -> None:
        super().__init__(processor=processor, mock=False)
        self.sample_rate = sample_rate
        self.hop_length = hop_length
        self.data_queue = data_queue
        self.queue = RECVQueue()
        self.last_chunk = None

    def run(self) -> None:
        """Read audio chunks from data_queue and extract features.

        Each item is either raw float32 PCM bytes or None (sentinel).
        On None or timeout, put STREAM_END into the output queue and return.
        """
        while True:
            try:
                data = self.data_queue.get(timeout=QUEUE_TIMEOUT)
            except queue.Empty:
                self.queue.put(STREAM_END)
                return

            if data is None:
                self.queue.put(STREAM_END)
                return

            audio_chunk = np.frombuffer(data, dtype=np.float32)
            timestamp = time.time() - (self.init_time or 0.0)
            self._process_feature(audio_chunk, timestamp)

            if not self.stream_start.is_set():
                self.stream_start.set()

    def _process_feature(
        self,
        target_audio: np.ndarray,
        f_time: float,
    ) -> None:
        """Extract features from an audio chunk, mirroring AudioStream logic.

        On the first call the chunk is zero-padded at the front.
        On subsequent calls the tail of the previous chunk is prepended
        for continuity across frame boundaries.
        """
        if self.last_chunk is None:
            target_audio = np.concatenate(
                (np.zeros(self.hop_length, dtype=np.float32), target_audio)
            )
        else:
            target_audio = np.concatenate((self.last_chunk, target_audio))

        features = self.processor(target_audio)

        if self.last_chunk is not None:
            self.queue.put((features, f_time))

        self.last_chunk = target_audio[-self.hop_length :]

    def __enter__(self) -> "WebSocketAudioStream":
        self.start_listening()
        self.start()
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> Optional[bool]:
        self.stop()
        if exc_type is not None:
            return False
        return True

    def stop(self) -> None:
        """Stop the stream: signal the thread and wait for it to finish."""
        self.stop_listening()
        # Unblock the thread if it is waiting on data_queue.get()
        try:
            self.data_queue.put_nowait(None)
        except queue.Full:
            pass
        self.join(timeout=5)
