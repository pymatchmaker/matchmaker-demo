import logging
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import mido
import partitura
import pyaudio
from matchmaker import Matchmaker
from partitura.score import Part

from .position_manager import position_manager


def convert_beat_to_quarter(score_part: Part, current_beat: float) -> float:
    timeline_time = score_part.inv_beat_map(current_beat)
    quarter_position = score_part.quarter_map(timeline_time)
    return float(quarter_position)


def add_xml_ids_to_mei(mei_path: Path) -> Path:
    """
    MEI 파일의 staffDef와 staff 요소에 xml:id 속성을 추가하여 partitura 호환성 확보

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

        # XML 네임스페이스 정의
        ET.register_namespace("", "http://www.music-encoding.org/ns/mei")
        ET.register_namespace("xml", "http://www.w3.org/XML/1998/namespace")

        # MEI 파일 파싱
        root = ET.fromstring(content)

        # MEI 네임스페이스
        ns = {
            "mei": "http://www.music-encoding.org/ns/mei",
        }

        # staffDef 요소 찾기
        staff_defs = root.findall(".//mei:staffDef", ns)

        # staff 요소 찾기
        staffs = root.findall(".//mei:staff", ns)

        staff_id_counter = 1
        staff_def_id_counter = 1
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

        if modified:
            # 수정된 XML을 문자열로 변환
            ET.register_namespace("", "http://www.music-encoding.org/ns/mei")
            tree = ET.ElementTree(root)

            # 원본 파일의 XML 선언과 인코딩 유지
            xml_declaration = '<?xml version="1.0" encoding="UTF-8"?>'
            if content.strip().startswith("<?xml"):
                # XML 선언 추출
                first_line = content.split("\n")[0]
                if "<?xml" in first_line:
                    xml_declaration = first_line

            # 수정된 내용 저장
            tree.write(mei_path, encoding="utf-8", xml_declaration=True)
            logging.info(f"Added xml:id attributes to MEI file: {mei_path}")

        return mei_path

    except Exception as e:
        logging.warning(f"Failed to add xml:id to MEI file {mei_path}: {e}")
        logging.warning(f"Error details: {traceback.format_exc()}")
        # 실패해도 원본 파일 반환 (다른 방법 시도)
        return mei_path


def preprocess_score(score_xml: Path) -> None:
    """
    Preprocess the score xml file to midi and audio file

    Parameters
    ----------
    score_xml : Path
        Path to the score xml file
    """
    # MEI 파일인 경우 특별 처리
    if score_xml.suffix.lower() == ".mei":
        try:
            # xml:id 속성 추가
            score_xml = add_xml_ids_to_mei(score_xml)

            # partitura로 MEI 로드 시도
            # partitura는 MEI를 완전히 지원하지 않을 수 있으므로 예외 처리
            try:
                score_obj = partitura.load_score_as_part(str(score_xml))

                score_midi_path = f"./uploads/{score_xml.stem}.mid"
                partitura.save_score_midi(score_obj, score_midi_path)

                score_audio_path = f"./uploads/{score_xml.stem}.wav"
                partitura.save_wav_fluidsynth(score_obj, score_audio_path)
            except (KeyError, AttributeError, ValueError) as e:
                # partitura가 MEI를 처리하지 못하는 경우
                # 프론트엔드에서 Verovio로만 렌더링하도록 함
                logging.warning(
                    f"Partitura could not process MEI file {score_xml}: {e}"
                )
                logging.warning(
                    "MEI file will be rendered with Verovio only (no MIDI/audio generation)"
                )
                # MIDI 파일이 없어도 프론트엔드에서 Verovio로 렌더링 가능
                # score following은 MIDI가 필요하므로 MEI 파일의 경우 제한적일 수 있음
                return
        except Exception as e:
            logging.error(f"Error preprocessing MEI file {score_xml}: {e}")
            logging.error(f"Error details: {traceback.format_exc()}")
            raise
    else:
        # MusicXML 파일인 경우 기존 로직 사용
        # score_obj = partitura.load_musicxml(score_xml)
        score_obj = partitura.load_score_as_part(str(score_xml))

        score_midi_path = f"./uploads/{score_xml.stem}.mid"
        partitura.save_score_midi(score_obj, score_midi_path)

        score_audio_path = f"./uploads/{score_xml.stem}.wav"
        partitura.save_wav_fluidsynth(score_obj, score_audio_path)


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
