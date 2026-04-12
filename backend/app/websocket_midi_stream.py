"""
WebSocket MIDI Stream

A Stream subclass that receives MIDI messages from an external queue
(fed by a WebSocket handler) instead of a physical MIDI device.
"""

import queue
import time
from types import TracebackType
from typing import Callable, List, Optional, Tuple, Type

import mido

from matchmaker.io.queue import RECVQueue
from matchmaker.io.stream import STREAM_END, Stream

QUEUE_TIMEOUT = 30


class WebSocketMidiStream(Stream):
    """A Stream that reads MIDI messages from a queue populated by a WebSocket handler.

    Parameters
    ----------
    processor : Callable
        Feature extraction callable (e.g., PitchIOIProcessor).
    data_queue : queue.Queue
        Queue where the WebSocket handler puts dicts like
        ``{"type": "note_on", "note": 60, "velocity": 100, "time": 0.5}``
        or ``None`` as a disconnect sentinel.
    """

    midi_messages: List[Tuple[mido.Message, float]]
    first_msg: bool

    def __init__(
        self,
        processor: Callable,
        data_queue: queue.Queue,
    ) -> None:
        super().__init__(processor=processor, mock=False)
        self.data_queue = data_queue
        self.queue = RECVQueue()
        self.midi_messages = []
        self.first_msg = False

    def run(self) -> None:
        """Read MIDI message dicts from data_queue and process them.

        Each item is either a dict with MIDI message data or None (sentinel).
        On None or timeout, put STREAM_END into the output queue and return.
        """
        self.start_listening()

        while self.listen:
            try:
                data = self.data_queue.get(timeout=QUEUE_TIMEOUT)
            except queue.Empty:
                self.queue.put(STREAM_END)
                return

            if data is None:
                self.queue.put(STREAM_END)
                return

            # Build mido.Message from the dict
            msg_type = data.get("type", "note_on")
            if msg_type == "note_on":
                msg = mido.Message(
                    "note_on",
                    note=int(data["note"]),
                    velocity=int(data.get("velocity", 64)),
                )
            elif msg_type == "note_off":
                msg = mido.Message(
                    "note_off",
                    note=int(data["note"]),
                    velocity=int(data.get("velocity", 0)),
                )
            else:
                continue

            c_time = self.current_time
            self.midi_messages.append((msg, c_time))
            self.first_msg = True

            self._process_frame_message(msg, c_time)

    def _process_frame_message(
        self,
        data: mido.Message,
        c_time: float,
    ) -> None:
        """Process a single MIDI message through the processor pipeline.

        Mirrors MidiStream._process_frame_message exactly.
        """
        output = self.processor(([(data, c_time)], c_time))

        if output is None:
            return

        self.queue.put(output)

        if not self.stream_start.is_set():
            self.stream_start.set()

    @property
    def current_time(self) -> float:
        """Get current time since starting to listen."""
        if self.init_time is None:
            self.init_time = time.time()
            return 0.0
        return time.time() - self.init_time

    def __enter__(self) -> "WebSocketMidiStream":
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
