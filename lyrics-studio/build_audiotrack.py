"""One-off: extract a clean AudioTrack (with one prototype arrangement
AudioClip) from a donor set, for embedding the processed song in exports.

IMPORTANT: the donor must have the SAME schema version as template.xml
(MinorVersion 10.0_377 — AbleSet's Lyrics Track Generator template). A donor
from a different schema generation (e.g. 10.0_370) produces a set that
segfaults Live while parsing.

Usage: python3 build_audiotrack.py <donor.xml>   ->  writes audiotrack.xml
"""
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
TEMPLATE_SCHEMA = "10.0_377"


def clear(elem):
    if elem is not None:
        for c in list(elem):
            elem.remove(c)


def main(donor_path: str) -> None:
    root = ET.parse(donor_path).getroot()
    if root.get("MinorVersion") != TEMPLATE_SCHEMA:
        sys.exit(f"Donor schema {root.get('MinorVersion')} != template {TEMPLATE_SCHEMA}")

    track = root.find("LiveSet/Tracks/AudioTrack")
    clip = track.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
    if clip is None:
        sys.exit("Donor audio track has no arrangement clip.")

    name = track.find("Name")
    for tag in ("EffectiveName", "UserName"):
        el = name.find(tag)
        if el is not None:
            el.set("Value", "Song Audio")
    el = name.find("MemorizedFirstClipName")
    if el is not None:
        el.set("Value", "")
    track.set("Id", "10")
    for tag in ("TrackGroupId", "LinkedTrackGroupId"):
        el = track.find(tag)
        if el is not None:
            el.set("Value", "-1")

    clear(track.find("AutomationEnvelopes/Envelopes"))
    clear(track.find("PostProcessFreezeClips"))
    dc = track.find("DeviceChain")
    clear(dc.find("DeviceChain/Devices"))
    clear(dc.find("Mixer/Sends"))          # template set has no return tracks
    for slot in dc.iter("ClipSlot"):
        v = slot.find("Value")
        if v is not None:
            clear(v)
    fs = dc.find("FreezeSequencer")
    if fs is not None:
        for ev in fs.iter("Events"):
            clear(ev)

    # scrub donor-sample leftovers from the prototype clip
    clip.set("Id", "0")
    clip.set("Time", "0")
    for tag in ("Onsets", "SavedWarpMarkersForStretched"):
        clear(clip.find(tag))
    gid = clip.find("GrooveSettings/GrooveId")
    if gid is not None:
        gid.set("Value", "-1")             # donor grooves don't exist here
    clear(clip.find("SampleRef/SourceContext"))
    fr = clip.find("SampleRef/FileRef")
    for tag in ("LivePackName", "LivePackId"):
        el = fr.find(tag)
        if el is not None:
            el.set("Value", "")
    data = fr.find("Data")
    if data is not None:
        data.text = ""

    events = dc.find("MainSequencer/Sample/ArrangerAutomation/Events")
    clear(events)
    events.append(clip)

    out = APP_DIR / "audiotrack.xml"
    out.write_bytes(ET.tostring(track, encoding="utf-8"))
    print(f"Wrote {out} ({out.stat().st_size:,} bytes) from schema {TEMPLATE_SCHEMA} donor")


if __name__ == "__main__":
    main(sys.argv[1])
