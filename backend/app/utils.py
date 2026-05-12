import json
import logging
import queue
import shutil
import subprocess
import threading
import traceback
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path
from typing import Optional

import mido
import partitura
from lxml import etree as lxml_etree
from matchmaker import Matchmaker
from partitura.score import Part

from matchmaker.io.audio import BytesAudioStream
from matchmaker.io.midi import BytesMidiStream

from .position_manager import position_manager


def convert_beat_to_quarter(score_part: Part, current_beat: float) -> float:
    timeline_time = score_part.inv_beat_map(current_beat)
    quarter_position = score_part.quarter_map(timeline_time)
    return float(quarter_position)


def add_xml_ids_to_mei(mei_path: Path) -> Path:
    """
    Add xml:id attributes to staffDef, staff, and staffGrp elements in an MEI file for partitura compatibility

    Parameters
    ----------
    mei_path : Path
        Path to the MEI file

    Returns
    -------
    Path
        Path to the modified MEI file (modifies the original file in place)
    """
    try:
        # Read MEI file
        with open(mei_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Parse using lxml (needed for the getparent() method)
        parser = lxml_etree.XMLParser(remove_blank_text=True)
        root = lxml_etree.fromstring(content.encode("utf-8"), parser=parser)

        # MEI namespace
        ns = {
            "mei": "http://www.music-encoding.org/ns/mei",
        }
        mei_ns = "http://www.music-encoding.org/ns/mei"

        # Find staffDef elements
        staff_defs = root.findall(".//mei:staffDef", ns)

        # Find staff elements
        staffs = root.findall(".//mei:staff", ns)

        # Find staffGrp elements
        staffgroups = root.findall(".//mei:staffGrp", ns)

        staff_id_counter = 1
        staff_def_id_counter = 1
        staffgroup_id_counter = 1
        modified = False
        xml_id_attr = "{http://www.w3.org/XML/1998/namespace}id"

        # Add xml:id to staffDef elements
        for staff_def in staff_defs:
            xml_id = staff_def.get(xml_id_attr)
            if xml_id is None:
                # Generate id using n attribute (fall back to sequential number)
                n_attr = staff_def.get("n")
                if n_attr:
                    xml_id = f"staffDef-{n_attr}"
                else:
                    xml_id = f"staffDef-{staff_def_id_counter}"
                    staff_def_id_counter += 1

                staff_def.set(xml_id_attr, xml_id)
                modified = True

        # Add xml:id to staff elements
        for staff in staffs:
            xml_id = staff.get(xml_id_attr)
            if xml_id is None:
                # Generate id using n attribute (fall back to sequential number)
                n_attr = staff.get("n")
                if n_attr:
                    xml_id = f"staff-{n_attr}"
                else:
                    xml_id = f"staff-{staff_id_counter}"
                    staff_id_counter += 1

                staff.set(xml_id_attr, xml_id)
                modified = True

        # Add xml:id to staffGrp elements
        for staffgroup in staffgroups:
            xml_id = staffgroup.get(xml_id_attr)
            if xml_id is None:
                # Generate id using n attribute (fall back to sequential number)
                n_attr = staffgroup.get("n")
                if n_attr:
                    xml_id = f"staffGrp-{n_attr}"
                else:
                    xml_id = f"staffGrp-{staffgroup_id_counter}"
                    staffgroup_id_counter += 1

                staffgroup.set(xml_id_attr, xml_id)
                modified = True

        # Convert meter.sym to meter.count/meter.unit (partitura compatibility)
        meter_sym_map = {
            "common": ("4", "4"),
            "cut": ("2", "2"),
        }
        for elem in root.xpath(
            ".//mei:staffDef | .//mei:scoreDef | .//mei:meterSig",
            namespaces=ns,
        ):
            sym = elem.get("meter.sym")
            if sym and sym in meter_sym_map and elem.get("meter.count") is None:
                count, unit = meter_sym_map[sym]
                elem.set("meter.count", count)
                elem.set("meter.unit", unit)
                modified = True
                logging.info(
                    f"Converted meter.sym='{sym}' to meter.count={count}/meter.unit={unit}"
                )

        # Add default tstamp to dir elements missing tstamp (partitura compatibility)
        for dir_el in root.xpath(".//mei:dir[not(@tstamp)]", namespaces=ns):
            dir_el.set("tstamp", "1")
            modified = True

        # Add xml:id to rest elements
        rests = root.xpath(".//mei:rest", namespaces=ns)
        rest_id_counter = 1
        for rest in rests:
            xml_id = rest.get(xml_id_attr)
            if xml_id is None:
                xml_id = f"rest-{rest_id_counter}"
                rest_id_counter += 1
                rest.set(xml_id_attr, xml_id)
                modified = True

        # Add xml:id to note elements (if missing)
        notes = root.xpath(".//mei:note", namespaces=ns)
        note_id_counter = 1
        for note in notes:
            xml_id = note.get(xml_id_attr)
            if xml_id is None:
                xml_id = f"note-{note_id_counter}"
                note_id_counter += 1
                note.set(xml_id_attr, xml_id)
                modified = True

        # Convert or remove note elements without pname attribute
        # partitura cannot handle note elements without pname
        notes_without_pname = root.xpath(".//mei:note[not(@pname)]", namespaces=ns)
        for note in notes_without_pname:
            # Convert note to rest
            parent = note.getparent()
            if parent is not None:
                # Get the existing note's xml:id
                note_xml_id = note.get(xml_id_attr)

                # Create rest element
                rest = lxml_etree.Element(f"{{{mei_ns}}}rest")
                # Copy only useful attributes from note (e.g., dur)
                for attr, value in note.attrib.items():
                    if attr not in [
                        xml_id_attr,
                        "pname",
                        "oct",
                        "accid",
                    ]:  # Exclude pitch-related attributes
                        rest.set(attr, value)

                # Set xml:id (reuse existing note id or generate new one)
                if note_xml_id:
                    rest.set(xml_id_attr, note_xml_id.replace("note-", "rest-"))
                else:
                    rest.set(xml_id_attr, f"rest-{rest_id_counter}")
                    rest_id_counter += 1

                # Replace note with rest
                parent.replace(note, rest)
                modified = True
                logging.debug(
                    f"Converted note without pname to rest: {dict(note.attrib)}"
                )

        if modified:
            # Convert modified XML to string
            # Save using lxml
            xml_string = lxml_etree.tostring(
                root, encoding="utf-8", xml_declaration=True, pretty_print=True
            ).decode("utf-8")

            # Save modified content
            with open(mei_path, "w", encoding="utf-8") as f:
                f.write(xml_string)
            logging.info(
                f"Added xml:id attributes and fixed notes in MEI file: {mei_path}"
            )

        return mei_path

    except Exception as e:
        logging.warning(f"Failed to add xml:id to MEI file {mei_path}: {e}")
        logging.warning(f"Error details: {traceback.format_exc()}")
        # Return original file even on failure (allow other approaches to be tried)
        return mei_path


def patch_partitura_mei_parser():
    """
    Patch partitura's MEI parser to handle rest elements
    """
    try:
        from partitura.io import importmei

        # Save original _pitch_info method
        original_pitch_info = importmei.MeiParser._pitch_info

        def patched_pitch_info(self, note_el):
            """
            Patched _pitch_info that can handle rest elements.
            Note elements without pname are treated as rests.
            """
            # Handle exception to prevent KeyError when pname attribute is missing
            if "pname" not in note_el.attrib:
                # Missing pname - this is either a rest element or an invalid note element.
                # partitura cannot handle this, so instead of raising an exception,
                # return a default value (though ideally this note should be skipped)
                logging.debug(
                    f"Note element without pname (likely rest): {note_el.tag}, "
                    f"attrs: {list(note_el.attrib.keys())}"
                )
                # partitura's _handle_note cannot accept step=None, so
                # temporarily return a default value (this note should not be processed).
                # However, partitura's internal logic may raise an exception here, so
                # try calling the original method first and return default on failure
                try:
                    return original_pitch_info(self, note_el)
                except KeyError:
                    # Failed due to missing pname - should be treated as rest.
                    # However, _handle_note is only called for notes, so
                    # safely return a default value here to prevent errors.
                    # Ideally this note should be skipped, but partitura's structure makes that difficult
                    return "C", 4, 0  # Temporary default (may not actually be used)

            # Call original method
            return original_pitch_info(self, note_el)

        # Apply method patch
        importmei.MeiParser._pitch_info = patched_pitch_info
        logging.info("Patched partitura MEI parser to handle rest elements")

    except Exception as e:
        logging.warning(f"Failed to patch partitura MEI parser: {e}")


def patch_partitura_midi_export():
    """
    Patch partitura's MIDI export function to handle None values
    """
    try:
        from partitura.io import exportmidi
        import numpy as np

        # Save original get_ppq function
        original_get_ppq = exportmidi.get_ppq

        def patched_get_ppq(parts):
            """
            Filter out None values so numpy lcm can process them.
            Original: ppqs = np.concatenate([part.quarter_durations()[:, 1] for part in score.iter_parts(parts)])
            """
            import partitura.score as score_module

            ppqs = []
            for part in score_module.iter_parts(parts):
                try:
                    # quarter_durations() is a method that returns an array
                    qd_array = part.quarter_durations()
                    if qd_array is not None and hasattr(qd_array, "shape"):
                        # Index [:, 1] like the original code (second column)
                        if len(qd_array.shape) >= 2 and qd_array.shape[1] > 1:
                            ppq_values = qd_array[:, 1]
                        else:
                            # Handle 1-dimensional array case
                            ppq_values = qd_array.flatten()

                        # Filter for valid values only
                        for val in ppq_values:
                            if val is not None:
                                try:
                                    # Check that value is numeric and not NaN
                                    if isinstance(
                                        val, (int, float, np.integer, np.floating)
                                    ):
                                        # Only check isnan for float values
                                        if isinstance(val, float):
                                            if np.isnan(val):
                                                continue
                                        # Convert to integer
                                        ppq_int = int(val)
                                        if ppq_int > 0:
                                            ppqs.append(ppq_int)
                                except (TypeError, ValueError, OverflowError):
                                    continue
                except (AttributeError, TypeError, IndexError) as e:
                    logging.debug(f"Error getting quarter_durations from part: {e}")
                    continue

            if not ppqs:
                # Use default value
                logging.warning("No valid ppq values found, using default 480")
                return 480

            # Remove None values then calculate lcm
            ppqs = [p for p in ppqs if p is not None and p > 0]
            if not ppqs:
                return 480

            try:
                return np.lcm.reduce(ppqs)
            except (TypeError, ValueError) as e:
                logging.warning(f"Error calculating lcm of ppqs {ppqs}: {e}")
                # Use default value
                return 480

        # Apply function patch
        exportmidi.get_ppq = patched_get_ppq
        logging.info("Patched partitura MIDI export to handle None values")

    except Exception as e:
        logging.warning(f"Failed to patch partitura MIDI export: {e}")
        logging.warning(f"Error details: {traceback.format_exc()}")


def enrich_musicxml_from_mei(musicxml_path: Path, mei_path: Path) -> None:
    """
    Enrich partitura-converted MusicXML with metadata, beaming, and final barlines from the original MEI
    """
    mei_ns = {"mei": "http://www.music-encoding.org/ns/mei"}
    mei_tree = lxml_etree.parse(str(mei_path))

    mxml_tree = ET.parse(str(musicxml_path))
    mxml_root = mxml_tree.getroot()

    # 1) Add title and composer
    title_el = mei_tree.xpath("//mei:title", namespaces=mei_ns)
    composer_el = mei_tree.xpath('//mei:persName[@role="composer"]', namespaces=mei_ns)
    subtitle_els = mei_tree.xpath(
        '//mei:rend[@type="subtitle"]', namespaces=mei_ns
    )

    title = title_el[0].text.strip() if title_el and title_el[0].text else None
    composer = (
        composer_el[0].text.strip() if composer_el and composer_el[0].text else None
    )
    subtitle = (
        subtitle_els[0].text.strip()
        if subtitle_els and subtitle_els[0].text
        else None
    )

    if title or composer:
        # Add identification block (before part-list)
        part_list = mxml_root.find("part-list")
        if part_list is not None:
            idx = list(mxml_root).index(part_list)

            if title:
                work = ET.Element("work")
                work_title = ET.SubElement(work, "work-title")
                work_title.text = title
                mxml_root.insert(idx, work)
                idx += 1

                # movement-title (subtitle or title)
                mov_title = ET.Element("movement-title")
                mov_title.text = subtitle if subtitle else title
                mxml_root.insert(idx, mov_title)
                idx += 1

            if composer:
                ident = ET.Element("identification")
                creator = ET.SubElement(ident, "creator", type="composer")
                creator.text = composer
                mxml_root.insert(idx, ident)

    # 2) Add part names
    labels = mei_tree.xpath("//mei:label", namespaces=mei_ns)
    label_abbrs = mei_tree.xpath("//mei:labelAbbr", namespaces=mei_ns)
    score_parts = mxml_root.findall(".//score-part")

    if labels and len(labels) >= 1:
        label_text = labels[0].text.strip() if labels[0].text else ""
        abbr_text = (
            label_abbrs[0].text.strip()
            if label_abbrs and label_abbrs[0].text
            else ""
        )
        for sp in score_parts:
            pn = sp.find("part-name")
            if pn is not None:
                pn.text = label_text
            pa = sp.find("part-abbreviation")
            if pa is None and abbr_text:
                pa = ET.SubElement(sp, "part-abbreviation")
                pa.text = abbr_text

    # 3) Add final barlines
    mei_measures = mei_tree.xpath("//mei:measure", namespaces=mei_ns)
    final_measure_nums = set()
    for m in mei_measures:
        if m.get("right") == "end":
            n = m.get("n")
            if n:
                final_measure_nums.add(n)

    for part in mxml_root.findall("part"):
        for measure in part.findall("measure"):
            if measure.get("number") in final_measure_nums:
                # Check if barline already exists
                if measure.find("barline") is None:
                    barline = ET.SubElement(
                        measure, "barline", location="right"
                    )
                    bar_style = ET.SubElement(barline, "bar-style")
                    bar_style.text = "light-heavy"

    # 4) Add beaming - convert MEI beam groups to MusicXML beam elements
    for staff_n, part in enumerate(mxml_root.findall("part"), start=1):
        for measure in part.findall("measure"):
            measure_num = measure.get("number")

            # Extract MEI beam info for this measure
            mei_measure = mei_tree.xpath(
                f'//mei:measure[@n="{measure_num}"]',
                namespaces=mei_ns,
            )
            if not mei_measure:
                continue

            # Collect beam groups for this staff
            beams = mei_measure[0].xpath(
                f".//mei:staff[@n='{staff_n}']//mei:beam",
                namespaces=mei_ns,
            )

            # Map beam info in order of note xml:id within beam
            xml_id_attr = "{http://www.w3.org/XML/1998/namespace}id"
            beam_info: dict[str, list[str]] = (
                {}
            )  # note_xml_id -> [beam_value_level1, ...]
            for beam in beams:
                beam_notes = beam.xpath("mei:note", namespaces=mei_ns)
                # Exclude notes inside nested beams (direct children only)
                direct_notes = [
                    n for n in beam_notes if n.getparent() == beam
                ]
                sub_beams = beam.xpath("mei:beam", namespaces=mei_ns)

                all_items: list[tuple[str, str, int]] = (
                    []
                )  # (xml_id, beam_value, level)

                # Process direct child notes (level 1 beam)
                child_items = []
                for child in beam:
                    tag = lxml_etree.QName(child.tag).localname
                    if tag == "note":
                        nid = child.get(xml_id_attr, "")
                        child_items.append(("note", nid, child))
                    elif tag == "beam":
                        # Notes within sub-beam
                        sub_notes = child.xpath(
                            "mei:note", namespaces=mei_ns
                        )
                        for sn in sub_notes:
                            nid = sn.get(xml_id_attr, "")
                            child_items.append(("sub_note", nid, sn))

                # Assign level 1 beam values
                note_ids_in_beam = [
                    (kind, nid) for kind, nid, _ in child_items
                ]
                for i, (kind, nid) in enumerate(note_ids_in_beam):
                    if i == 0:
                        beam_info.setdefault(nid, []).append("begin")
                    elif i == len(note_ids_in_beam) - 1:
                        beam_info.setdefault(nid, []).append("end")
                    else:
                        beam_info.setdefault(nid, []).append("continue")

                # Process level 2 beam (sub-beam)
                for sub_beam in sub_beams:
                    sub_notes = sub_beam.xpath(
                        "mei:note", namespaces=mei_ns
                    )
                    for i, sn in enumerate(sub_notes):
                        nid = sn.get(xml_id_attr, "")
                        if i == 0:
                            beam_info.setdefault(nid, []).append("begin")
                        elif i == len(sub_notes) - 1:
                            beam_info.setdefault(nid, []).append("end")
                        else:
                            beam_info.setdefault(nid, []).append(
                                "continue"
                            )

            if not beam_info:
                continue

            # Note order in MEI staff (all notes regardless of beam grouping)
            mei_staff = mei_measure[0].xpath(
                f".//mei:staff[@n='{staff_n}']", namespaces=mei_ns
            )
            if not mei_staff:
                continue

            mei_notes_ordered = mei_staff[0].xpath(
                ".//mei:note", namespaces=mei_ns
            )
            mei_note_ids = [
                n.get(xml_id_attr, "") for n in mei_notes_ordered
            ]

            # Note order in MusicXML
            mxml_notes = [
                n for n in measure.findall("note") if n.find("rest") is None
            ]

            # note type -> number of beam levels needed
            type_to_levels = {
                "eighth": 1,
                "16th": 2,
                "32nd": 3,
                "64th": 4,
            }

            # Beam insertion position: after stem, before notations
            beam_insert_after = {"stem", "notehead", "staff", "type", "dot",
                                 "accidental", "time-modification"}

            # Apply beams using order mapping
            mei_idx = 0
            for mxml_note in mxml_notes:
                if mei_idx >= len(mei_note_ids):
                    break
                nid = mei_note_ids[mei_idx]
                mei_idx += 1

                if nid not in beam_info:
                    continue

                # Determine required beam levels from note type
                note_type_el = mxml_note.find("type")
                note_type = note_type_el.text if note_type_el is not None else ""
                needed_levels = type_to_levels.get(note_type, 1)

                # Level 1 value comes from MEI
                level1_val = beam_info[nid][0]

                # Find insertion position
                insert_idx = len(list(mxml_note))
                for i, child in enumerate(mxml_note):
                    if child.tag in ("notations", "lyric"):
                        insert_idx = i
                        break

                # Add all required beam levels
                for level in range(1, needed_levels + 1):
                    if level <= len(beam_info[nid]):
                        val = beam_info[nid][level - 1]
                    else:
                        val = level1_val  # Same duration group follows the same pattern
                    beam_el = ET.Element("beam", number=str(level))
                    beam_el.text = val
                    mxml_note.insert(insert_idx, beam_el)
                    insert_idx += 1

    # Save
    mxml_tree.write(str(musicxml_path), encoding="unicode", xml_declaration=True)
    logging.info(f"Enriched MusicXML with MEI metadata: {musicxml_path}")


def process_pdf_with_audiveris(pdf_path: Path, file_id: str) -> Optional[dict]:
    """Run Audiveris OMR on a PDF, extract PNG + pixel mapping + MXL."""
    from .audiveris_launcher import AudiverisNotFound, run_audiveris

    upload_dir = Path("./uploads")
    output_dir = upload_dir / f"{file_id}_audiveris"
    output_dir.mkdir(exist_ok=True)

    try:
        result = run_audiveris(pdf_path, output_dir, timeout=600.0)
        logging.info(f"Audiveris stdout: {result.stdout[-200:]}")
        if result.returncode != 0:
            logging.error(f"Audiveris stderr: {result.stderr[-500:]}")
    except AudiverisNotFound as e:
        logging.error(f"Audiveris not found: {e}")
        return None
    except subprocess.TimeoutExpired:
        logging.error("Audiveris timed out")
        return None

    # Find .omr file
    omr_files = list(output_dir.glob("*.omr"))
    if not omr_files:
        logging.error("No .omr file produced by Audiveris")
        return None
    omr_path = omr_files[0]

    # Find .mxl file
    mxl_files = list(output_dir.glob("*.mxl"))
    mxl_dest = None
    if mxl_files:
        mxl_dest = upload_dir / f"{file_id}_score.mxl"
        shutil.copy(mxl_files[0], mxl_dest)

    # Extract from .omr ZIP
    png_dest = upload_dir / f"{file_id}_score.png"
    pixel_mapping = None

    with zipfile.ZipFile(omr_path) as zf:
        # Extract BINARY.png
        for name in zf.namelist():
            if name.endswith("BINARY.png"):
                with zf.open(name) as src, open(png_dest, "wb") as dst:
                    dst.write(src.read())
                break

        # Parse sheet XML for pixel mapping
        for name in zf.namelist():
            if name.endswith(".xml") and "sheet" in name and "book" not in name:
                with zf.open(name) as f:
                    pixel_mapping = _parse_omr_pixel_mapping(f.read())
                break

    if pixel_mapping:
        # Add image dimensions
        pic_width, pic_height = 0, 0
        with zipfile.ZipFile(omr_path) as zf:
            for name in zf.namelist():
                if name.endswith(".xml") and "sheet" in name and "book" not in name:
                    with zf.open(name) as f:
                        root = ET.parse(f).getroot()
                        pic = root.find("picture")
                        if pic is not None:
                            pic_width = int(float(pic.get("width", 0)))
                            pic_height = int(float(pic.get("height", 0)))
                    break
        pixel_mapping["image_width"] = pic_width
        pixel_mapping["image_height"] = pic_height

        mapping_path = upload_dir / f"{file_id}_pixel_mapping.json"
        mapping_path.write_text(json.dumps(pixel_mapping))

    # Generate MIDI directly from .omr (bypasses buggy MXL export)
    midi_dest = None
    try:
        from .omr_parser import omr_to_midi
        midi_dest = upload_dir / f"{file_id}_score.mid"
        omr_to_midi(omr_path, midi_dest)
        logging.info(f"Generated MIDI from .omr directly: {midi_dest}")
    except Exception as e:
        logging.error(f"OMR direct MIDI failed: {e}, falling back to MXL")
        midi_dest = None

    # Cleanup temp dir (but keep .omr for potential re-parsing)
    # Move .omr to uploads before cleanup
    omr_keep = upload_dir / f"{file_id}_score.omr"
    shutil.copy(omr_path, omr_keep)
    shutil.rmtree(output_dir, ignore_errors=True)

    return {
        "mxl_path": mxl_dest,
        "midi_path": midi_dest,
        "omr_path": omr_keep,
        "png_path": png_dest if png_dest.exists() else None,
        "pixel_mapping": pixel_mapping,
    }


def _parse_omr_pixel_mapping(xml_bytes: bytes) -> dict:
    """Parse Audiveris sheet XML to build quarter_position → pixel coordinate mapping."""
    root = ET.fromstring(xml_bytes)
    entries = []
    measure_quarter = Fraction(0)

    for system in root.findall(".//page/system"):
        # Get staff Y ranges for this system
        staff_ys = []
        for part in system.findall("part"):
            for staff in part.findall("staff"):
                for line in staff.findall(".//line"):
                    for point in line.findall("point"):
                        staff_ys.append(int(float(point.get("y"))))

        sys_top = min(staff_ys) if staff_ys else 0
        sys_bottom = max(staff_ys) if staff_ys else 0

        for stack in system.findall("stack"):
            stack_left = int(float(stack.get("left")))
            stack_right = int(float(stack.get("right")))
            duration = Fraction(stack.get("duration"))

            for slot in stack.findall("slot"):
                x_offset = int(float(slot.get("x-offset")))
                time_frac = Fraction(slot.get("time-offset"))

                abs_x = stack_left + x_offset
                abs_quarter = float(measure_quarter + time_frac * 4)

                entries.append({
                    "quarter": round(abs_quarter, 4),
                    "x": abs_x,
                    "measure_left": stack_left,
                    "measure_right": stack_right,
                    "system_top": sys_top,
                    "system_bottom": sys_bottom,
                })

            measure_quarter += duration * 4

    return {"entries": entries}


def preprocess_score(score_xml: Path, file_id: str = "", user_tempo: Optional[float] = None) -> Optional[dict | Path]:
    """
    Preprocess the score file to midi and audio.
    Returns dict for PDF, Path for MEI->MusicXML conversion, None for MusicXML.
    """
    # PDF: run Audiveris OMR
    if score_xml.suffix.lower() == ".pdf":
        if not file_id:
            file_id = score_xml.stem.split("_")[0]
        result = process_pdf_with_audiveris(score_xml, file_id)
        if not result:
            raise ValueError("Audiveris failed to process PDF")

        upload_dir = Path("./uploads")
        midi_path = result.get("midi_path")

        if midi_path and Path(midi_path).exists():
            # Use MIDI generated directly from .omr (more accurate)
            score_obj = partitura.load_score(str(midi_path))
            logging.info(f"PDF preprocessed using OMR-direct MIDI: {midi_path}")
        elif result.get("mxl_path"):
            # Fallback to MXL
            mxl_path = result["mxl_path"]
            score_obj = partitura.load_score(str(mxl_path))
            midi_path = upload_dir / f"{file_id}_score.mid"
            partitura.save_score_midi(score_obj, str(midi_path))
            logging.info(f"PDF preprocessed using MXL fallback: {midi_path}")
        else:
            raise ValueError("Audiveris failed to produce usable output")

        # Detect tempo: user input > score marking > default 120
        if user_tempo is not None:
            bpm = user_tempo
        else:
            from matchmaker.utils.misc import get_tempo_from_score
            score_part = partitura.load_score_as_part(str(midi_path))
            mxl_path_for_tempo = result.get("mxl_path")
            bpm = get_tempo_from_score(score_part, str(mxl_path_for_tempo) if mxl_path_for_tempo else None)
            if bpm is None:
                bpm = 120.0
        logging.info(f"PDF tempo: {bpm} BPM (source: {'user' if user_tempo else 'auto'})")

        wav_path = upload_dir / f"{file_id}_score.wav"
        partitura.save_wav_fluidsynth(score_obj, str(wav_path), bpm=bpm)

        return {"type": "pdf", "bpm": bpm, **result}

    # Special handling for MEI files
    if score_xml.suffix.lower() == ".mei":
        try:
            # Patch partitura MEI parser
            patch_partitura_mei_parser()

            # Patch partitura MIDI export
            patch_partitura_midi_export()

            # Add xml:id attributes
            score_xml = add_xml_ids_to_mei(score_xml)

            score_obj = partitura.load_score(str(score_xml))
            logging.info(f"Successfully loaded MEI file: {score_xml}")

            # Convert to MusicXML (for frontend OSMD rendering)
            musicxml_path = score_xml.parent / f"{score_xml.stem}.musicxml"
            partitura.save_musicxml(score_obj, str(musicxml_path))
            logging.info(f"Converted MEI to MusicXML: {musicxml_path}")

            # Enrich with metadata, beaming, and final barlines from original MEI
            enrich_musicxml_from_mei(musicxml_path, score_xml)


            # Save MIDI file
            score_midi_path = f"./uploads/{score_xml.stem}.mid"
            partitura.save_score_midi(score_obj, score_midi_path)
            logging.info(f"Successfully saved MIDI file: {score_midi_path}")

            # Save audio file
            score_audio_path = f"./uploads/{score_xml.stem}.wav"
            partitura.save_wav_fluidsynth(score_obj, score_audio_path)
            logging.info(f"Successfully saved audio file: {score_audio_path}")

            return musicxml_path

        except Exception as e:
            logging.error(f"Error preprocessing MEI file {score_xml}: {e}")
            logging.error(f"Error details: {traceback.format_exc()}")
            raise
    else:
        # Use existing logic for MusicXML files
        score_obj = partitura.load_score_as_part(str(score_xml))

        score_midi_path = f"./uploads/{score_xml.stem}.mid"
        partitura.save_score_midi(score_obj, score_midi_path)

        score_audio_path = f"./uploads/{score_xml.stem}.wav"
        partitura.save_wav_fluidsynth(score_obj, score_audio_path)

        return None


def find_score_file_by_id(file_id: str, directory: Path = Path("./uploads")) -> Path:
    for file in directory.iterdir():
        if file.is_file() and file.stem.startswith(file_id):
            if file.suffix in [".xml", ".mei", ".musicxml", ".mxl"]:
                return file
            elif file.suffix in [".mid", ".midi"]:
                return file
    return None


def find_performance_file_by_id(
    file_id: str, directory: Path = Path("./uploads")
) -> Optional[Path]:
    """Find the original performance file (excludes converted _performance_audio.wav)"""
    for file in directory.iterdir():
        if (
            file.is_file()
            and file.stem.startswith(f"{file_id}_performance")
            and not file.stem.endswith("_performance_audio")
        ):
            return file
    return None


def get_audio_devices() -> list[dict]:
    """
    Get the list of audio devices available on the system
    The default device is always the first one in the list.

    Returns
    -------
    devices: list[dict]
        List of audio devices with index and name

    """
    try:
        import pyaudio  # optional: only needed to enumerate local audio devices
        p = pyaudio.PyAudio()
        device_count = p.get_device_count()
        default_device = p.get_default_input_device_info()
        devices = []
        for i in range(device_count):
            device_info = p.get_device_info_by_index(i)
            if device_info == default_device:
                continue
            devices.append({"index": device_info["index"], "name": device_info["name"]})
        devices.insert(
            0, {"index": default_device["index"], "name": default_device["name"]}
        )
        p.terminate()
    except Exception as e:
        logging.error(f"Error: {e}")
        devices = [{"index": 0, "name": "No audio devices found"}]
    return devices


def get_midi_devices() -> list[dict]:
    """
    Get the list of midi devices available on the system
    The default device is always the first one in the list.

    Returns
    -------
    devices: list[dict]
        List of midi devices with index and name

    """
    try:
        devices = []
        for i, device in enumerate(mido.get_input_names()):
            devices.append({"index": i, "name": device})
    except Exception as e:
        logging.error(f"Error: {e}")
        devices = [{"index": 0, "name": "No midi devices found"}]
    return devices


def run_precomputed_alignment(file_id: str, method: str = "audio_outerhmm") -> Optional[list[dict]]:
    """Run offline alignment and return [{time, position}] pairs."""
    score_file = find_score_file_by_id(file_id)
    if not score_file:
        logging.error(f"Score file not found for file_id: {file_id}")
        return None

    # Resolve MIDI file
    if score_file.suffix.lower() == ".mei":
        midi_file = score_file.parent / f"{score_file.stem}.mid"
        if not midi_file.exists():
            logging.error(f"MIDI file not found for: {score_file}")
            return None
        score_midi = str(midi_file)
    else:
        score_midi = str(score_file)

    score_part = partitura.load_score_as_part(score_midi)
    performance_file = find_performance_file_by_id(file_id)
    if not performance_file:
        logging.error(f"Performance file not found for file_id: {file_id}")
        return None

    perf_suffix = performance_file.suffix.lower()
    input_type = "midi" if perf_suffix in [".mid", ".midi"] else "audio"

    # Use appropriate default method if the provided one doesn't match input_type
    audio_methods = {"arzt", "dixon", "pthmm", "audio_outerhmm"}
    midi_methods = {"arzt", "dixon", "hmm", "pthmm", "outerhmm"}
    valid_methods = midi_methods if input_type == "midi" else audio_methods
    if method not in valid_methods:
        method = "outerhmm" if input_type == "midi" else "audio_outerhmm"
        logging.info(f"Method overridden to '{method}' for input_type '{input_type}'")

    mm = Matchmaker(
        score_file=score_midi,
        performance_file=str(performance_file),
        input_type=input_type,
        method=method,
    )

    import math

    # Get timing info for mapping positions to time
    frame_rate = mm.frame_rate or 1
    perf_duration: Optional[float] = None
    if input_type == "midi":
        # Use WAV duration (what browser actually plays) for accurate sync
        perf_wav = performance_file.parent / f"{file_id}_performance_audio.wav"
        if perf_wav.exists():
            import wave
            with wave.open(str(perf_wav)) as w:
                perf_duration = w.getnframes() / w.getframerate()
        else:
            perf_duration = mido.MidiFile(str(performance_file)).length

    # Collect valid positions via Matchmaker.run() which handles
    # stream lifecycle (start_listening/stop_listening) correctly
    positions: list[float] = []
    try:
        for pos in mm.run(verbose=True):
            val = float(pos)
            if not math.isnan(val):
                positions.append(val)
    except (TypeError, ValueError):
        pass
    except queue.Empty:
        pass

    logging.info(f"Alignment completed: {len(positions)} positions")

    # Build alignment: map quarter_position → time
    # First pass: collect all quarter positions
    quarter_positions: list[float] = []
    for beat_pos in positions:
        quarter_positions.append(convert_beat_to_quarter(score_part, beat_pos))

    # Determine time scale: use actual WAV duration / score's total quarter length
    # Use score's last quarter (not alignment output) so all methods map consistently
    import numpy as np
    na = score_part.note_array()
    score_end_quarter = float(np.max(na['onset_quarter'] + na['duration_quarter']))
    if input_type == "midi" and perf_duration and score_end_quarter > 0:
        sec_per_quarter = perf_duration / score_end_quarter
    else:
        sec_per_quarter = None

    alignment = []
    prev_quarter = None
    for i, quarter_pos in enumerate(quarter_positions):
        if sec_per_quarter is not None:
            time_sec = float(quarter_pos) * sec_per_quarter
        else:
            time_sec = float(i) / frame_rate
        if quarter_pos != prev_quarter:
            alignment.append({"time": round(time_sec, 4), "position": float(quarter_pos)})
            prev_quarter = quarter_pos

    if alignment:
        import json
        alignment_path = Path(f"./uploads/{file_id}_alignment.json")
        alignment_path.write_text(json.dumps(alignment))
        logging.info(f"Saved precomputed alignment: {len(alignment)} entries")

    return alignment


def run_score_following(file_id: str, input_type: str, device: str, method: str = "audio_outerhmm", stop_event: Optional[threading.Event] = None) -> None:
    score_file = find_score_file_by_id(file_id)
    if not score_file:
        logging.error(f"Score file not found for file_id: {file_id}")
        return

    # For MEI files, try to find the MIDI file
    if score_file.suffix.lower() == ".mei":
        # MIDI file may not have been generated for MEI files
        midi_file = score_file.parent / f"{score_file.stem}.mid"
        if not midi_file.exists():
            logging.error(f"MIDI file not found for MEI file: {score_file}")
            logging.error(
                "Score following requires MIDI file. MEI file may not be fully supported."
            )
            return
        score_midi = str(midi_file)
    else:
        score_midi = str(score_file)

    score_part = partitura.load_score_as_part(score_midi)
    print(f"Running score following with {score_midi}")

    # Find performance file
    performance_file = find_performance_file_by_id(file_id)

    # Determine input_type
    actual_input_type = (
        "audio"
        if performance_file and performance_file.suffix in [".wav", ".mp3"]
        else (
            "midi"
            if performance_file and performance_file.suffix == ".mid"
            else input_type
        )  # Use the input_type argument when no performance file is present
    )

    print(f"Using input type: {actual_input_type}")

    alignment_in_progress = True
    mm = Matchmaker(
        score_file=score_midi,
        performance_file=performance_file if performance_file else None,
        input_type=actual_input_type,
        device_name_or_index=device if not performance_file else None,
        method=method,
    )

    try:
        print(f"Running score following... (input type: {actual_input_type}, method: {method})")
        for current_position in mm.run():
            if stop_event and stop_event.is_set():
                print("Score following stopped by client")
                try:
                    if mm.stream and hasattr(mm.stream, 'queue'):
                        mm.stream.queue.put(None)
                except Exception:
                    pass
                break
            quarter_position = convert_beat_to_quarter(score_part, current_position)
            position_manager.set_position(file_id, quarter_position)
    except Exception as e:
        logging.error(f"Error: {e}")
        traceback.print_exc()
        return {"error": str(e)}


class WebSocketMatchmaker(Matchmaker):
    """Matchmaker subclass that uses WebSocket streams instead of local devices."""

    def __init__(self, data_queue: queue.Queue, **kwargs):
        self._data_queue = data_queue
        super().__init__(**kwargs)

    def _build_stream(self, method, wait):
        if self.input_type == "midi":
            return BytesMidiStream(
                processor=self.processor,
                data_queue=self._data_queue,
            )
        return BytesAudioStream(
            processor=self.processor,
            sample_rate=self.sample_rate,
            hop_length=self.hop_length,
            data_queue=self._data_queue,
        )


def run_websocket_score_following(
    file_id: str,
    method: str,
    data_queue: queue.Queue,
    input_type: str = "audio",
    stop_event: Optional[threading.Event] = None,
    ready_event: Optional[threading.Event] = None,
) -> None:
    score_file = find_score_file_by_id(file_id)
    if not score_file:
        logging.error(f"Score file not found for file_id: {file_id}")
        return

    if score_file.suffix.lower() == ".mei":
        midi_file = score_file.parent / f"{score_file.stem}.mid"
        if not midi_file.exists():
            logging.error(f"MIDI file not found for MEI file: {score_file}")
            return
        score_midi = str(midi_file)
    else:
        score_midi = str(score_file)

    score_part = partitura.load_score_as_part(score_midi)
    print(f"Running WebSocket score following ({input_type}) with {score_midi}")

    mm = WebSocketMatchmaker(
        data_queue=data_queue,
        score_file=score_midi,
        input_type=input_type,
        method=method,
    )

    if ready_event:
        ready_event.set()
        print(f"Matchmaker initialized and ready (method: {method}, input: {input_type})")

    try:
        print(f"Running WebSocket score following... (method: {method}, input: {input_type})")
        for current_position in mm.run():
            if stop_event and stop_event.is_set():
                print("WebSocket score following stopped by client")
                try:
                    if mm.stream and hasattr(mm.stream, 'data_queue'):
                        mm.stream.data_queue.put(None)
                except Exception:
                    pass
                break
            quarter_position = convert_beat_to_quarter(score_part, current_position)
            position_manager.set_position(file_id, quarter_position)
    except queue.Empty:
        logging.info("WebSocket stream ended (queue empty)")
    except Exception as e:
        logging.error(f"WebSocket score following error: {e}")
        traceback.print_exc()
        return {"error": str(e)}
