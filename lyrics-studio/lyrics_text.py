"""The head of a lyric document, which is not sung.

A typed-up lyric sheet usually opens with what it is: the song's title, the
artist, "Lyrics", "Words and music by…". Left in, those lines are given times
and written as clips. Only the top of the document is looked at, and only a
block set apart from the words by a blank line — a first sung line that
happens to be the title, with the verse running straight on, stays.

Pure Python, no dependencies.
"""
from __future__ import annotations

import re

# "Title: …", "Artist - …", "Written by …", "Lyrics", "Lyrics to …"
LABEL = re.compile(
    r"^\s*(title|song(\s+title)?|artist|band|singer|performed\s+by|by|album|year|writers?|"
    r"written\s+by|words(\s+and\s+music)?(\s+by)?|music(\s+by)?|composer|composed\s+by|"
    r"lyrics(\s+by)?|key|capo|tempo|bpm|time(\s+signature)?)\s*[:\-–—]\s*\S", re.I)
BARE = re.compile(r"^\s*(lyrics|song\s*lyrics|chords\s*(&|and)\s*lyrics|lyric\s*sheet)\s*$", re.I)
LYRICS_TO = re.compile(r"^\s*lyrics\s+(to|for)\b", re.I)


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", re.sub(r"['’]", "", text.lower().replace("&", " and ")))


def _title_words(title: str) -> list[str]:
    # A title's own brackets — "(Live)" — are not part of how a sheet names it.
    return _words(re.sub(r"[(\[][^)\]]*[)\]]", " ", title))


def _has_run(have: list[str], want: list[str]) -> bool:
    return bool(want) and any(have[i:i + len(want)] == want for i in range(len(have) - len(want) + 1))


def _names_song(line: str, titles: list[list[str]]) -> bool:
    """The line is the title, or the title with the artist — "Artist - Title",
    "Title by Artist", "Title (Artist)" — and little else."""
    have = _words(line)
    if not have:
        return False
    for want in titles:
        if not _has_run(have, want):
            continue
        extra = len(have) - len(want)
        if extra == 0:
            return True
        if re.search(r"\s[-–—]\s|\sby\s|\(|\[|\|", line, re.I) and extra <= 6:
            return True
    return False


def strip_header(text: str, titles: list[str]) -> str:
    """The document without its title block. `titles` are what the song may be
    called: its title in the set, its file's name."""
    # A file's name carries a track number and often the artist: each piece may be the title.
    names = []
    for t in titles:
        t = re.sub(r"^\s*\d+\s*[.)_\-–—]*\s*", "", t or "")
        names += [t] + re.split(r"\s[-–—]\s|_-_", t)
    wanted = [w for w in (_title_words(t) for t in names if t) if w]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # Labelled lines and a bare "Lyrics" at the very top, whatever follows them.
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    top = i
    while i < len(lines) and (LABEL.match(lines[i]) or BARE.match(lines[i]) or LYRICS_TO.match(lines[i])):
        i += 1
    start = i if i > top else top

    # Then a short block, set apart by a blank line, that names the song.
    j = start
    while j < len(lines) and not lines[j].strip():
        j += 1
    k = j
    while k < len(lines) and lines[k].strip():
        k += 1
    block = lines[j:k]
    if block and k < len(lines) and len(block) <= 3 and any(_names_song(b, wanted) for b in block) \
            and all(len(_words(b)) <= 8 and not re.search(r"[.,!?;]$", b.strip()) for b in block):
        start = k
    return "\n".join(lines[start:]).lstrip("\n")
