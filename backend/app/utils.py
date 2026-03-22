import logging
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import mido
import partitura
import pyaudio
from lxml import etree as lxml_etree
from matchmaker import Matchmaker
from partitura.score import Part

from .position_manager import position_manager


def convert_beat_to_quarter(score_part: Part, current_beat: float) -> float:
    timeline_time = score_part.inv_beat_map(current_beat)
    quarter_position = score_part.quarter_map(timeline_time)
    return float(quarter_position)


def add_xml_ids_to_mei(mei_path: Path) -> Path:
    """
    MEI 파일의 staffDef, staff, staffgroup 요소에 xml:id 속성을 추가하여 partitura 호환성 확보

    Parameters
    ----------
    mei_path : Path
        MEI 파일 경로

    Returns
    -------
    Path
        수정된 MEI 파일 경로 (원본 파일을 수정)
    """
    try:
        # MEI 파일 읽기
        with open(mei_path, "r", encoding="utf-8") as f:
            content = f.read()

        # lxml을 사용하여 파싱 (getparent() 메서드 사용을 위해)
        parser = lxml_etree.XMLParser(remove_blank_text=True)
        root = lxml_etree.fromstring(content.encode("utf-8"), parser=parser)

        # MEI 네임스페이스
        ns = {
            "mei": "http://www.music-encoding.org/ns/mei",
        }
        mei_ns = "http://www.music-encoding.org/ns/mei"

        # staffDef 요소 찾기
        staff_defs = root.findall(".//mei:staffDef", ns)

        # staff 요소 찾기
        staffs = root.findall(".//mei:staff", ns)

        # staffgroup 요소 찾기
        staffgroups = root.findall(".//mei:staffGrp", ns)

        staff_id_counter = 1
        staff_def_id_counter = 1
        staffgroup_id_counter = 1
        modified = False
        xml_id_attr = "{http://www.w3.org/XML/1998/namespace}id"

        # staffDef 요소에 xml:id 추가
        for staff_def in staff_defs:
            xml_id = staff_def.get(xml_id_attr)
            if xml_id is None:
                # n 속성을 사용하여 id 생성 (없으면 순차 번호 사용)
                n_attr = staff_def.get("n")
                if n_attr:
                    xml_id = f"staffDef-{n_attr}"
                else:
                    xml_id = f"staffDef-{staff_def_id_counter}"
                    staff_def_id_counter += 1

                staff_def.set(xml_id_attr, xml_id)
                modified = True

        # staff 요소에 xml:id 추가
        for staff in staffs:
            xml_id = staff.get(xml_id_attr)
            if xml_id is None:
                # n 속성을 사용하여 id 생성 (없으면 순차 번호 사용)
                n_attr = staff.get("n")
                if n_attr:
                    xml_id = f"staff-{n_attr}"
                else:
                    xml_id = f"staff-{staff_id_counter}"
                    staff_id_counter += 1

                staff.set(xml_id_attr, xml_id)
                modified = True

        # staffgroup 요소에 xml:id 추가
        for staffgroup in staffgroups:
            xml_id = staffgroup.get(xml_id_attr)
            if xml_id is None:
                # n 속성을 사용하여 id 생성 (없으면 순차 번호 사용)
                n_attr = staffgroup.get("n")
                if n_attr:
                    xml_id = f"staffGrp-{n_attr}"
                else:
                    xml_id = f"staffGrp-{staffgroup_id_counter}"
                    staffgroup_id_counter += 1

                staffgroup.set(xml_id_attr, xml_id)
                modified = True

        # meter.sym → meter.count/meter.unit 변환 (partitura 호환)
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

        # tstamp가 없는 dir 요소에 기본 tstamp 추가 (partitura 호환)
        for dir_el in root.xpath(".//mei:dir[not(@tstamp)]", namespaces=ns):
            dir_el.set("tstamp", "1")
            modified = True

        # rest 요소에 xml:id 추가
        rests = root.xpath(".//mei:rest", namespaces=ns)
        rest_id_counter = 1
        for rest in rests:
            xml_id = rest.get(xml_id_attr)
            if xml_id is None:
                xml_id = f"rest-{rest_id_counter}"
                rest_id_counter += 1
                rest.set(xml_id_attr, xml_id)
                modified = True

        # note 요소에 xml:id 추가 (없는 경우)
        notes = root.xpath(".//mei:note", namespaces=ns)
        note_id_counter = 1
        for note in notes:
            xml_id = note.get(xml_id_attr)
            if xml_id is None:
                xml_id = f"note-{note_id_counter}"
                note_id_counter += 1
                note.set(xml_id_attr, xml_id)
                modified = True

        # pname이 없는 note 요소를 rest로 변환하거나 제거
        # partitura는 pname이 없는 note를 처리할 수 없음
        notes_without_pname = root.xpath(".//mei:note[not(@pname)]", namespaces=ns)
        for note in notes_without_pname:
            # note를 rest로 변환
            parent = note.getparent()
            if parent is not None:
                # 기존 note의 xml:id 가져오기
                note_xml_id = note.get(xml_id_attr)

                # rest 요소 생성
                rest = lxml_etree.Element(f"{{{mei_ns}}}rest")
                # note의 속성 중 dur 등 유용한 것만 복사
                for attr, value in note.attrib.items():
                    if attr not in [
                        xml_id_attr,
                        "pname",
                        "oct",
                        "accid",
                    ]:  # pitch 관련 속성 제외
                        rest.set(attr, value)

                # xml:id 설정 (기존 note의 id 사용하거나 새로 생성)
                if note_xml_id:
                    rest.set(xml_id_attr, note_xml_id.replace("note-", "rest-"))
                else:
                    rest.set(xml_id_attr, f"rest-{rest_id_counter}")
                    rest_id_counter += 1

                # note를 rest로 교체
                parent.replace(note, rest)
                modified = True
                logging.debug(
                    f"Converted note without pname to rest: {dict(note.attrib)}"
                )

        if modified:
            # 수정된 XML을 문자열로 변환
            # lxml을 사용하여 저장
            xml_string = lxml_etree.tostring(
                root, encoding="utf-8", xml_declaration=True, pretty_print=True
            ).decode("utf-8")

            # 수정된 내용 저장
            with open(mei_path, "w", encoding="utf-8") as f:
                f.write(xml_string)
            logging.info(
                f"Added xml:id attributes and fixed notes in MEI file: {mei_path}"
            )

        return mei_path

    except Exception as e:
        logging.warning(f"Failed to add xml:id to MEI file {mei_path}: {e}")
        logging.warning(f"Error details: {traceback.format_exc()}")
        # 실패해도 원본 파일 반환 (다른 방법 시도)
        return mei_path


def patch_partitura_mei_parser():
    """
    partitura의 MEI 파서를 패치하여 rest 요소를 처리할 수 있도록 함
    """
    try:
        from partitura.io import importmei

        # 원본 _pitch_info 메서드 저장
        original_pitch_info = importmei.MeiParser._pitch_info

        def patched_pitch_info(self, note_el):
            """
            rest 요소를 처리할 수 있도록 패치된 _pitch_info
            pname이 없는 note 요소는 rest로 간주하여 처리
            """
            # pname 속성이 없으면 KeyError를 방지하기 위해 예외 처리
            if "pname" not in note_el.attrib:
                # pname이 없는 경우 - 이는 rest 요소이거나 잘못된 note 요소
                # partitura는 이를 처리할 수 없으므로, 예외를 발생시키지 않고
                # 기본값을 반환하되, 실제로는 이 note는 건너뛰어야 함
                logging.debug(
                    f"Note element without pname (likely rest): {note_el.tag}, "
                    f"attrs: {list(note_el.attrib.keys())}"
                )
                # partitura의 _handle_note는 step이 None일 수 없으므로
                # 임시로 기본값을 반환 (실제로는 이 note는 처리되지 않아야 함)
                # 하지만 partitura의 내부 로직을 보면, 이 경우 예외가 발생할 수 있으므로
                # try-except로 원본 메서드를 호출하고, 실패하면 기본값 반환
                try:
                    return original_pitch_info(self, note_el)
                except KeyError:
                    # pname이 없어서 실패한 경우 - rest로 처리되어야 함
                    # 하지만 _handle_note는 note에만 호출되므로,
                    # 여기서는 안전하게 기본값을 반환하여 에러를 방지
                    # 실제로는 이 note는 건너뛰어야 하지만, partitura의 구조상 어려움
                    return "C", 4, 0  # 임시 기본값 (실제로는 사용되지 않을 수 있음)

            # 원본 메서드 호출
            return original_pitch_info(self, note_el)

        # 메서드 패치
        importmei.MeiParser._pitch_info = patched_pitch_info
        logging.info("Patched partitura MEI parser to handle rest elements")

    except Exception as e:
        logging.warning(f"Failed to patch partitura MEI parser: {e}")


def patch_partitura_midi_export():
    """
    partitura의 MIDI export 함수를 패치하여 None 값 처리
    """
    try:
        from partitura.io import exportmidi
        import numpy as np

        # 원본 get_ppq 함수 저장
        original_get_ppq = exportmidi.get_ppq

        def patched_get_ppq(parts):
            """
            None 값을 필터링하여 numpy lcm이 처리할 수 있도록 함
            원본: ppqs = np.concatenate([part.quarter_durations()[:, 1] for part in score.iter_parts(parts)])
            """
            import partitura.score as score_module

            ppqs = []
            for part in score_module.iter_parts(parts):
                try:
                    # quarter_durations()는 메서드이고 배열을 반환
                    qd_array = part.quarter_durations()
                    if qd_array is not None and hasattr(qd_array, "shape"):
                        # 원본 코드처럼 [:, 1] 인덱싱 (두 번째 컬럼)
                        if len(qd_array.shape) >= 2 and qd_array.shape[1] > 1:
                            ppq_values = qd_array[:, 1]
                        else:
                            # 1차원 배열인 경우
                            ppq_values = qd_array.flatten()

                        # 유효한 값만 필터링
                        for val in ppq_values:
                            if val is not None:
                                try:
                                    # 숫자 타입이고 NaN이 아닌지 확인
                                    if isinstance(
                                        val, (int, float, np.integer, np.floating)
                                    ):
                                        # float인 경우에만 isnan 체크
                                        if isinstance(val, float):
                                            if np.isnan(val):
                                                continue
                                        # 정수로 변환
                                        ppq_int = int(val)
                                        if ppq_int > 0:
                                            ppqs.append(ppq_int)
                                except (TypeError, ValueError, OverflowError):
                                    continue
                except (AttributeError, TypeError, IndexError) as e:
                    logging.debug(f"Error getting quarter_durations from part: {e}")
                    continue

            if not ppqs:
                # 기본값 사용
                logging.warning("No valid ppq values found, using default 480")
                return 480

            # None 값 제거 후 lcm 계산
            ppqs = [p for p in ppqs if p is not None and p > 0]
            if not ppqs:
                return 480

            try:
                return np.lcm.reduce(ppqs)
            except (TypeError, ValueError) as e:
                logging.warning(f"Error calculating lcm of ppqs {ppqs}: {e}")
                # 기본값 사용
                return 480

        # 함수 패치
        exportmidi.get_ppq = patched_get_ppq
        logging.info("Patched partitura MIDI export to handle None values")

    except Exception as e:
        logging.warning(f"Failed to patch partitura MIDI export: {e}")
        logging.warning(f"Error details: {traceback.format_exc()}")


def enrich_musicxml_from_mei(musicxml_path: Path, mei_path: Path) -> None:
    """
    partitura가 변환한 MusicXML에 원본 MEI의 메타데이터, beaming, 종지선을 보충
    """
    mei_ns = {"mei": "http://www.music-encoding.org/ns/mei"}
    mei_tree = lxml_etree.parse(str(mei_path))

    mxml_tree = ET.parse(str(musicxml_path))
    mxml_root = mxml_tree.getroot()

    # 1) 제목, 작곡가 추가
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
        # identification 블록 추가 (part-list 앞에)
        part_list = mxml_root.find("part-list")
        if part_list is not None:
            idx = list(mxml_root).index(part_list)

            if title:
                work = ET.Element("work")
                work_title = ET.SubElement(work, "work-title")
                work_title.text = title
                mxml_root.insert(idx, work)
                idx += 1

                # movement-title (subtitle 또는 title)
                mov_title = ET.Element("movement-title")
                mov_title.text = subtitle if subtitle else title
                mxml_root.insert(idx, mov_title)
                idx += 1

            if composer:
                ident = ET.Element("identification")
                creator = ET.SubElement(ident, "creator", type="composer")
                creator.text = composer
                mxml_root.insert(idx, ident)

    # 2) 파트 이름 추가
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

    # 3) 종지선 추가
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
                # 이미 barline이 있는지 확인
                if measure.find("barline") is None:
                    barline = ET.SubElement(
                        measure, "barline", location="right"
                    )
                    bar_style = ET.SubElement(barline, "bar-style")
                    bar_style.text = "light-heavy"

    # 4) Beaming 추가 - MEI의 beam 그룹을 MusicXML beam 요소로 변환
    for staff_n, part in enumerate(mxml_root.findall("part"), start=1):
        for measure in part.findall("measure"):
            measure_num = measure.get("number")

            # 해당 마디의 MEI beam 정보 추출
            mei_measure = mei_tree.xpath(
                f'//mei:measure[@n="{measure_num}"]',
                namespaces=mei_ns,
            )
            if not mei_measure:
                continue

            # 이 staff의 beam 그룹 수집
            beams = mei_measure[0].xpath(
                f".//mei:staff[@n='{staff_n}']//mei:beam",
                namespaces=mei_ns,
            )

            # beam 안의 note xml:id 순서대로 beam 정보 매핑
            xml_id_attr = "{http://www.w3.org/XML/1998/namespace}id"
            beam_info: dict[str, list[str]] = (
                {}
            )  # note_xml_id -> [beam_value_level1, ...]
            for beam in beams:
                beam_notes = beam.xpath("mei:note", namespaces=mei_ns)
                # 중첩 beam 내부의 노트는 제외 (직계 자식만)
                direct_notes = [
                    n for n in beam_notes if n.getparent() == beam
                ]
                sub_beams = beam.xpath("mei:beam", namespaces=mei_ns)

                all_items: list[tuple[str, str, int]] = (
                    []
                )  # (xml_id, beam_value, level)

                # 직계 노트 처리 (level 1 beam)
                child_items = []
                for child in beam:
                    tag = lxml_etree.QName(child.tag).localname
                    if tag == "note":
                        nid = child.get(xml_id_attr, "")
                        child_items.append(("note", nid, child))
                    elif tag == "beam":
                        # sub-beam의 노트들
                        sub_notes = child.xpath(
                            "mei:note", namespaces=mei_ns
                        )
                        for sn in sub_notes:
                            nid = sn.get(xml_id_attr, "")
                            child_items.append(("sub_note", nid, sn))

                # level 1 beam 값 할당
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

                # level 2 beam (sub-beam) 처리
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

            # MEI staff의 노트 순서 (beam 여부 관계없이 전체 순서)
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

            # MusicXML의 노트 순서
            mxml_notes = [
                n for n in measure.findall("note") if n.find("rest") is None
            ]

            # note type → 필요한 beam level 수
            type_to_levels = {
                "eighth": 1,
                "16th": 2,
                "32nd": 3,
                "64th": 4,
            }

            # beam 삽입 위치: stem 뒤, notations 앞
            beam_insert_after = {"stem", "notehead", "staff", "type", "dot",
                                 "accidental", "time-modification"}

            # 순서 매핑으로 beam 적용
            mei_idx = 0
            for mxml_note in mxml_notes:
                if mei_idx >= len(mei_note_ids):
                    break
                nid = mei_note_ids[mei_idx]
                mei_idx += 1

                if nid not in beam_info:
                    continue

                # note type으로 필요한 beam level 결정
                note_type_el = mxml_note.find("type")
                note_type = note_type_el.text if note_type_el is not None else ""
                needed_levels = type_to_levels.get(note_type, 1)

                # level 1 값은 MEI에서 가져옴
                level1_val = beam_info[nid][0]

                # 삽입 위치 찾기
                insert_idx = len(list(mxml_note))
                for i, child in enumerate(mxml_note):
                    if child.tag in ("notations", "lyric"):
                        insert_idx = i
                        break

                # 필요한 모든 beam level 추가
                for level in range(1, needed_levels + 1):
                    if level <= len(beam_info[nid]):
                        val = beam_info[nid][level - 1]
                    else:
                        val = level1_val  # 동일 duration 그룹은 같은 패턴
                    beam_el = ET.Element("beam", number=str(level))
                    beam_el.text = val
                    mxml_note.insert(insert_idx, beam_el)
                    insert_idx += 1

    # 저장
    mxml_tree.write(str(musicxml_path), encoding="unicode", xml_declaration=True)
    logging.info(f"Enriched MusicXML with MEI metadata: {musicxml_path}")


def preprocess_score(score_xml: Path) -> Optional[Path]:
    """
    Preprocess the score xml file to midi and audio file.
    For MEI files, also converts to MusicXML for frontend rendering.

    Parameters
    ----------
    score_xml : Path
        Path to the score xml file

    Returns
    -------
    Optional[Path]
        Path to converted MusicXML file if original was MEI, None otherwise
    """
    # MEI 파일인 경우 특별 처리
    if score_xml.suffix.lower() == ".mei":
        try:
            # partitura MEI 파서 패치
            patch_partitura_mei_parser()

            # partitura MIDI export 패치
            patch_partitura_midi_export()

            # xml:id 속성 추가
            score_xml = add_xml_ids_to_mei(score_xml)

            score_obj = partitura.load_score(str(score_xml))
            logging.info(f"Successfully loaded MEI file: {score_xml}")

            # MusicXML 변환 (프론트엔드 OSMD 렌더링용)
            musicxml_path = score_xml.parent / f"{score_xml.stem}.musicxml"
            partitura.save_musicxml(score_obj, str(musicxml_path))
            logging.info(f"Converted MEI to MusicXML: {musicxml_path}")

            # 원본 MEI에서 메타데이터, beaming, 종지선 보충
            enrich_musicxml_from_mei(musicxml_path, score_xml)


            # MIDI 파일 저장
            score_midi_path = f"./uploads/{score_xml.stem}.mid"
            partitura.save_score_midi(score_obj, score_midi_path)
            logging.info(f"Successfully saved MIDI file: {score_midi_path}")

            # Audio 파일 저장
            score_audio_path = f"./uploads/{score_xml.stem}.wav"
            partitura.save_wav_fluidsynth(score_obj, score_audio_path)
            logging.info(f"Successfully saved audio file: {score_audio_path}")

            return musicxml_path

        except Exception as e:
            logging.error(f"Error preprocessing MEI file {score_xml}: {e}")
            logging.error(f"Error details: {traceback.format_exc()}")
            raise
    else:
        # MusicXML 파일인 경우 기존 로직 사용
        score_obj = partitura.load_score_as_part(str(score_xml))

        score_midi_path = f"./uploads/{score_xml.stem}.mid"
        partitura.save_score_midi(score_obj, score_midi_path)

        score_audio_path = f"./uploads/{score_xml.stem}.wav"
        partitura.save_wav_fluidsynth(score_obj, score_audio_path)

        return None


def find_score_file_by_id(file_id: str, directory: Path = Path("./uploads")) -> Path:
    for file in directory.iterdir():
        if file.is_file() and file.stem.startswith(file_id):
            if file.suffix in [".xml", ".mei", ".musicxml"]:
                return file
            elif file.suffix in [".mid", ".midi"]:
                return file
    return None


def find_performance_file_by_id(
    file_id: str, directory: Path = Path("./uploads")
) -> Optional[Path]:
    """Find performance file with the given file_id"""
    for file in directory.iterdir():
        if file.is_file() and file.stem.startswith(f"{file_id}_performance"):
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


def run_score_following(file_id: str, input_type: str, device: str) -> None:
    score_file = find_score_file_by_id(file_id)
    if not score_file:
        logging.error(f"Score file not found for file_id: {file_id}")
        return

    # MEI 파일인 경우 MIDI 파일 찾기 시도
    if score_file.suffix.lower() == ".mei":
        # MEI 파일의 경우 MIDI 파일이 생성되지 않았을 수 있음
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

    # performance 파일 찾기
    performance_file = find_performance_file_by_id(file_id)

    # input_type 결정
    actual_input_type = (
        "audio"
        if performance_file and performance_file.suffix in [".wav", ".mp3"]
        else (
            "midi"
            if performance_file and performance_file.suffix == ".mid"
            else input_type
        )  # performance 파일이 없을 경우 인자로 받은 input_type 사용
    )

    print(f"Using input type: {actual_input_type}")

    alignment_in_progress = True
    mm = Matchmaker(
        score_file=score_midi,
        performance_file=performance_file if performance_file else None,
        input_type=actual_input_type,
        device_name_or_index=device if not performance_file else None,
    )

    try:
        while alignment_in_progress:
            print(f"Running score following... (input type: {actual_input_type})")
            for current_position in mm.run():
                quarter_position = convert_beat_to_quarter(score_part, current_position)
                position_manager.set_position(file_id, quarter_position)
            alignment_in_progress = False
    except Exception as e:
        logging.error(f"Error: {e}")
        traceback.print_exc()
        return {"error": str(e)}
