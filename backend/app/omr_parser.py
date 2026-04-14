"""
Parse Audiveris .omr files directly to extract note events.

Bypasses the MXL export (which often garbles staff separation and voice
assignment) and reads the internal sheet XML where Audiveris stores its
recognition results.

Output: a list of NoteEvent(pitch_midi, onset_quarters, duration_quarters, staff)
sorted by onset time.
"""

from __future__ import annotations

import logging
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Diatonic helpers
# ---------------------------------------------------------------------------

# Audiveris "pitch" = diatonic steps from the middle staff line (line 3).
# G_CLEF  middle line = B4  (MIDI 71)
# F_CLEF  middle line = D3  (MIDI 50)
# C_CLEF  middle line = B3  (MIDI 59)  (alto/tenor)

_CLEF_BASE: dict[str, tuple[int, int]] = {
    # clef_shape -> (base_midi, base_note_index)
    # note_index in _NOTE_NAMES: B=0 C=1 D=2 E=3 F=4 G=5 A=6
    "G_CLEF": (71, 0),       # B4
    "G_CLEF_SMALL": (71, 0), # B4 (courtesy/cue)
    "G_CLEF_8VB": (59, 0),   # B3 (octave below)
    "G_CLEF_8VA": (83, 0),   # B5 (octave above)
    "F_CLEF": (50, 2),       # D3
    "F_CLEF_SMALL": (50, 2), # D3 (courtesy/cue)
    "F_CLEF_8VB": (38, 2),   # D2 (octave below)
    "F_CLEF_8VA": (62, 2),   # D4 (octave above)
    "C_CLEF": (59, 0),       # B3
    "PERCUSSION_CLEF": (60, 1),
}

_NOTE_NAMES = ["B", "C", "D", "E", "F", "G", "A"]

# Semitone offsets from B within one diatonic octave (B C D E F G A)
_SEMI = [0, 1, 3, 5, 6, 8, 10]

# Order of sharps / flats in key signatures (by note index in _NOTE_NAMES)
_SHARP_ORDER = [4, 1, 5, 2, 6, 3, 0]  # F C G D A E B
_FLAT_ORDER  = [0, 3, 6, 2, 5, 1, 4]  # B E A D G C F


def _key_sig_alterations(fifths: int) -> dict[int, int]:
    """Return {note_index: semitone_delta} for a key signature."""
    alterations: dict[int, int] = {}
    if fifths > 0:
        for i in range(min(fifths, 7)):
            alterations[_SHARP_ORDER[i]] = 1
    elif fifths < 0:
        for i in range(min(-fifths, 7)):
            alterations[_FLAT_ORDER[i]] = -1
    return alterations


def _pitch_to_midi(
    pitch: int,
    clef_shape: str,
    key_alterations: dict[int, int],
    accidental: Optional[str] = None,
) -> int:
    """Convert Audiveris diatonic pitch to MIDI number.

    Audiveris pitch: negative = higher on staff = higher pitch.
    We negate to get standard diatonic offset (positive = up).
    """
    diatonic = -pitch  # Audiveris convention is inverted
    base_midi, base_idx = _CLEF_BASE.get(clef_shape, _CLEF_BASE["G_CLEF"])
    note_idx = (base_idx + diatonic) % 7
    octave_offset = (base_idx + diatonic) // 7
    midi = base_midi + octave_offset * 12 + (_SEMI[note_idx] - _SEMI[base_idx])

    if accidental == "NATURAL":
        pass
    elif accidental == "SHARP":
        midi += 1
    elif accidental == "DOUBLE_SHARP":
        midi += 2
    elif accidental == "FLAT":
        midi -= 1
    elif accidental == "DOUBLE_FLAT":
        midi -= 2
    elif note_idx in key_alterations:
        midi += key_alterations[note_idx]

    return midi


# ---------------------------------------------------------------------------
# Duration helpers
# ---------------------------------------------------------------------------

_SHAPE_TO_QUARTERS: dict[str, Fraction] = {
    "NOTEHEAD_BLACK": Fraction(1, 4),       # quarter (default, refined by beams/flags)
    "NOTEHEAD_VOID":  Fraction(1, 2),       # half note (2 quarters)
    "WHOLE_NOTE":     Fraction(1, 1),       # whole note (4 quarters)
    "BREVE":          Fraction(2, 1),
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class NoteEvent:
    pitch_midi: int
    onset_quarters: Fraction
    duration_quarters: Fraction
    staff: int
    note_name: str = ""


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def parse_omr(omr_path: str | Path) -> list[NoteEvent]:
    """Parse an Audiveris .omr file and return a sorted list of NoteEvents."""
    omr_path = Path(omr_path)
    if not omr_path.exists():
        raise FileNotFoundError(omr_path)

    notes: list[NoteEvent] = []
    cumulative_offset = Fraction(0)  # running quarter offset across measures

    with zipfile.ZipFile(omr_path) as zf:
        # Determine sheet order from filenames
        sheet_names = sorted(
            [n for n in zf.namelist() if n.endswith(".xml") and "sheet#" in n],
            key=lambda n: int(n.split("sheet#")[1].split("/")[0]),
        )

        # Detect anacrusis from the very first stack
        if sheet_names:
            first_xml = ET.fromstring(zf.read(sheet_names[0]))
            first_stack = first_xml.find(".//page/system/stack")
            if first_stack is not None:
                dur = Fraction(first_stack.get("duration", "1/1"))
                exp = Fraction(first_stack.get("expected", first_stack.get("duration", "1/1")))
                if dur < exp:
                    # Anacrusis: start offset is negative so measure 1 begins at 0
                    cumulative_offset = -(dur * 4)

        for sheet_name in sheet_names:
            xml_bytes = zf.read(sheet_name)
            sheet_root = ET.fromstring(xml_bytes)
            sheet_notes, cumulative_offset = _parse_sheet(
                sheet_root, cumulative_offset
            )
            notes.extend(sheet_notes)

    notes.sort(key=lambda n: (n.onset_quarters, n.pitch_midi))
    # Deduplicate: same onset + pitch + staff = one note
    seen: set[tuple[float, int, int]] = set()
    deduped: list[NoteEvent] = []
    for n in notes:
        key = (float(n.onset_quarters), n.pitch_midi, n.staff)
        if key not in seen:
            seen.add(key)
            deduped.append(n)
    return deduped


def _parse_sheet(
    sheet: ET.Element, start_offset: Fraction
) -> tuple[list[NoteEvent], Fraction]:
    """Parse one sheet XML, returns (notes, updated cumulative offset)."""
    notes: list[NoteEvent] = []
    cumulative = start_offset

    # Per-staff state that carries across systems
    staff_clef: dict[int, str] = {}
    staff_key: dict[int, dict[int, int]] = {}

    for page in sheet.findall(".//page"):
        for system in page.findall("system"):
            sig = system.find("sig")
            if sig is None:
                continue
            inters = sig.find("inters")
            rels = sig.find("relations")
            if inters is None:
                continue

            # Determine staff index mapping: Audiveris numbers staves
            # sequentially within a system (1, 2, 3...) but for a piano
            # part with 2 staves we want canonical 1 and 2.
            # We use the part/staff structure to build the mapping.
            local_staff_map: dict[int, int] = {}
            canonical = 1
            for part in system.findall("part"):
                for staff_el in part.findall("staff"):
                    local_id = int(staff_el.get("id", str(canonical)))
                    local_staff_map[local_id] = canonical
                    canonical += 1
            # If no part/staff structure found, assume identity
            if not local_staff_map:
                local_staff_map = {1: 1, 2: 2}

            # ------ Build lookup structures ------
            id_map: dict[str, ET.Element] = {}
            for e in inters:
                eid = e.get("id")
                if eid:
                    id_map[eid] = e

            rel_graph: dict[str, list[tuple[str, str]]] = defaultdict(list)
            if rels is not None:
                for rel in rels:
                    src, tgt = rel.get("source"), rel.get("target")
                    rel_type = list(rel)[0].tag if len(rel) > 0 else ""
                    rel_graph[src].append((tgt, rel_type))
                    rel_graph[tgt].append((src, rel_type))

            # ------ Clefs (use canonical staff id) ------
            for clef_el in inters.findall("clef"):
                local_id = int(clef_el.get("staff", "1"))
                canon_id = local_staff_map.get(local_id, local_id)
                shape = clef_el.get("shape", "G_CLEF")
                staff_clef[canon_id] = shape

            # ------ Key signatures (use canonical staff id) ------
            for key_el in inters.findall("key"):
                local_id = int(key_el.get("staff", "1"))
                canon_id = local_staff_map.get(local_id, local_id)
                fifths = int(key_el.get("fifths", "0"))
                staff_key[canon_id] = _key_sig_alterations(fifths)

            # ------ Accidentals map: head_id -> accidental shape ------
            accidental_map: dict[str, str] = {}
            for alter_el in inters.findall("alter"):
                alter_id = alter_el.get("id")
                shape = alter_el.get("shape", "")
                for tgt_id, rel_type in rel_graph.get(alter_id, []):
                    if rel_type == "alter-head":
                        accidental_map[tgt_id] = shape

            # ------ Beam / flag counting for head-chords ------
            # beam count reduces duration: 1 beam = eighth, 2 = 16th, etc.
            chord_beam_count: dict[str, int] = defaultdict(int)
            chord_has_flag: dict[str, bool] = defaultdict(bool)

            for beam_group in inters.findall("beam-group"):
                bg_id = beam_group.get("id")
                # count beams connected to each chord through relations
                pass  # handled via relations below

            for beam_el in inters.findall("beam"):
                beam_id = beam_el.get("id")
                for tgt_id, rel_type in rel_graph.get(beam_id, []):
                    tgt = id_map.get(tgt_id)
                    if tgt is not None and tgt.tag == "head-chord":
                        chord_beam_count[tgt_id] += 1

            for flag_el in inters.findall("flag"):
                flag_id = flag_el.get("id")
                for tgt_id, rel_type in rel_graph.get(flag_id, []):
                    tgt = id_map.get(tgt_id)
                    if tgt is not None and tgt.tag == "head-chord":
                        chord_has_flag[tgt_id] = True

            # ------ Augmentation dots ------
            chord_dots: dict[str, int] = defaultdict(int)
            for dot_el in inters.findall("augmentation-dot"):
                dot_id = dot_el.get("id")
                for tgt_id, rel_type in rel_graph.get(dot_id, []):
                    if rel_type in ("augmentation", "dot"):
                        tgt = id_map.get(tgt_id)
                        if tgt is not None and tgt.tag == "head-chord":
                            chord_dots[tgt_id] += 1
                        elif tgt is not None and tgt.tag == "head":
                            # find parent chord
                            for c_id, c_rt in rel_graph.get(tgt_id, []):
                                c = id_map.get(c_id)
                                if c is not None and c.tag == "head-chord":
                                    chord_dots[c_id] += 1

            # ------ Collect all head-chords in this system once ------
            all_head_chords = inters.findall("head-chord")
            processed_hc_ids: set[str] = set()

            # ------ Process stacks (measures) ------
            stacks = system.findall("stack")
            for stack in stacks:
                stack_left = float(stack.get("left", 0))
                # Use actual "duration" for cumulative offset (handles anacrusis).
                # "expected" is the nominal full-measure duration; "duration" is
                # what Audiveris actually measured (shorter for pickup measures).
                actual_dur_str = stack.get("duration", "1/1")
                actual_dur = Fraction(actual_dur_str)
                # Convert to quarter notes (multiply by 4)
                measure_quarters = actual_dur * 4

                stack_right = float(stack.get("right", 0))
                stack_width = stack_right - stack_left
                if stack_width <= 0:
                    cumulative += measure_quarters
                    continue

                # Build slot list: (abs_x, time_offset_quarters)
                slots: list[tuple[float, Fraction]] = []
                for slot in stack.findall("slot"):
                    x_abs = stack_left + float(slot.get("x-offset", 0))
                    t_str = slot.get("time-offset", "0")
                    t_frac = Fraction(t_str) if t_str != "0" else Fraction(0)
                    t_quarters = t_frac * 4  # convert from whole-note fraction
                    slots.append((x_abs, t_quarters))

                # Match head-chords to timing
                for hc in all_head_chords:
                    hc_id = hc.get("id", "")
                    if hc_id in processed_hc_ids:
                        continue
                    bounds = hc.find("bounds")
                    if bounds is None:
                        continue
                    hc_x = float(bounds.get("x", 0))
                    local_staff = int(hc.get("staff", "1"))
                    staff_id = local_staff_map.get(local_staff, local_staff)

                    # Check if this chord is in this stack's x range
                    if not (stack_left <= hc_x <= stack_right):
                        continue
                    processed_hc_ids.add(hc_id)

                    # Determine onset time:
                    # 1) Try slot matching (if close enough, < 30px)
                    # 2) Fallback: linear interpolation from x position
                    best_slot_t: Fraction | None = None
                    best_dist = float("inf")
                    for sx, st in slots:
                        dist = abs(sx - hc_x)
                        if dist < best_dist:
                            best_dist = dist
                            best_slot_t = st

                    if best_slot_t is not None and best_dist < 30:
                        onset = cumulative + best_slot_t
                    else:
                        # x-proportional fallback
                        x_ratio = (hc_x - stack_left) / stack_width
                        onset = cumulative + Fraction(x_ratio * float(measure_quarters)).limit_denominator(64)

                    # Determine note duration from head shape + beams/flags
                    # Get head shapes in this chord
                    head_shapes = set()
                    head_ids = []
                    for tgt_id, rel_type in rel_graph.get(hc_id, []):
                        tgt = id_map.get(tgt_id)
                        if tgt is not None and tgt.tag == "head" and rel_type == "containment":
                            head_shapes.add(tgt.get("shape", "NOTEHEAD_BLACK"))
                            head_ids.append(tgt_id)

                    base_shape = "NOTEHEAD_BLACK"
                    if "NOTEHEAD_VOID" in head_shapes:
                        base_shape = "NOTEHEAD_VOID"
                    elif "WHOLE_NOTE" in head_shapes:
                        base_shape = "WHOLE_NOTE"

                    base_dur = _SHAPE_TO_QUARTERS.get(base_shape, Fraction(1))

                    if base_shape == "NOTEHEAD_BLACK":
                        n_beams = chord_beam_count.get(hc_id, 0)
                        if chord_has_flag.get(hc_id, False):
                            n_beams = max(n_beams, 1)
                        if n_beams > 0:
                            base_dur = Fraction(1) / (2 ** n_beams)
                        # else quarter note

                    # Augmentation dots
                    dots = chord_dots.get(hc_id, 0)
                    dur = base_dur
                    dot_add = base_dur
                    for _ in range(dots):
                        dot_add /= 2
                        dur += dot_add

                    # Get clef and key for this staff
                    clef = staff_clef.get(staff_id, "G_CLEF")
                    key_alt = staff_key.get(staff_id, {})

                    # Extract individual notes (heads) in this chord
                    for tgt_id, rel_type in rel_graph.get(hc_id, []):
                        tgt = id_map.get(tgt_id)
                        if tgt is None or tgt.tag != "head" or rel_type != "containment":
                            continue
                        pitch = int(tgt.get("pitch", "0"))
                        acc = accidental_map.get(tgt_id)
                        midi = _pitch_to_midi(pitch, clef, key_alt, acc)
                        note_idx = (_CLEF_BASE.get(clef, (71, 0))[1] + (-pitch)) % 7
                        name = _NOTE_NAMES[note_idx]

                        notes.append(NoteEvent(
                            pitch_midi=midi,
                            onset_quarters=onset,
                            duration_quarters=dur,
                            staff=staff_id,
                            note_name=name,
                        ))

                cumulative += measure_quarters

    return notes, cumulative


def omr_to_midi(omr_path: str | Path, output_path: str | Path, bpm: float = 120.0) -> Path:
    """Convert .omr to a MIDI file."""
    import mido

    notes = parse_omr(omr_path)
    if not notes:
        raise ValueError("No notes found in .omr file")

    output_path = Path(output_path)
    ticks_per_beat = 480
    tempo = mido.bpm2tempo(bpm)

    mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)

    # Split by staff
    staffs = defaultdict(list)
    for n in notes:
        staffs[n.staff].append(n)

    for staff_id in sorted(staffs):
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
        track.append(mido.MetaMessage("track_name", name=f"Staff {staff_id}", time=0))

        # Build sorted events: (tick, 'on'/'off', pitch, velocity)
        # Shift all onsets so the earliest note starts at tick 0
        min_onset = min(float(n.onset_quarters) for n in notes)
        shift = -min_onset if min_onset < 0 else 0
        events = []
        for n in staffs[staff_id]:
            on_tick = int((float(n.onset_quarters) + shift) * ticks_per_beat)
            off_tick = int((float(n.onset_quarters + n.duration_quarters) + shift) * ticks_per_beat)
            events.append((on_tick, 0, "note_on", n.pitch_midi, 80))
            events.append((off_tick, 1, "note_off", n.pitch_midi, 0))

        events.sort(key=lambda e: (e[0], e[1]))  # sort by tick, offs before ons at same tick

        last_tick = 0
        for tick, _, msg_type, pitch, vel in events:
            delta = tick - last_tick
            track.append(mido.Message(msg_type, note=pitch, velocity=vel, time=delta))
            last_tick = tick

    mid.save(str(output_path))
    log.info(f"Saved MIDI to {output_path} ({len(notes)} notes, {len(staffs)} staves)")
    return output_path


# ---------------------------------------------------------------------------
# Quick test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    omr_file = sys.argv[1] if len(sys.argv) > 1 else "uploads/3fabac57_audiveris/IMSLP55010.omr"
    notes = parse_omr(omr_file)
    print(f"Total notes: {len(notes)}")
    print(f"Staves: {set(n.staff for n in notes)}")
    print(f"Pitch range: {min(n.pitch_midi for n in notes)}-{max(n.pitch_midi for n in notes)}")
    print(f"Duration: {float(notes[-1].onset_quarters):.1f} quarters")
    print(f"\nFirst 20 notes:")
    for n in notes[:20]:
        print(f"  t={float(n.onset_quarters):7.2f}  midi={n.pitch_midi:3d}  dur={float(n.duration_quarters):.3f}  staff={n.staff}  {n.note_name}")
