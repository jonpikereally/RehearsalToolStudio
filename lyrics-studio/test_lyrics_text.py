import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lyrics_text import strip_header as h

T = ["Fix You"]
body = "When you try your best\nbut you don't succeed"
# title and artist block
assert h(f"Fix You\nColdplay\n\n{body}", T) == body
assert h(f"Coldplay - Fix You\n\n{body}", T) == body
assert h(f"Fix You by Coldplay\n\n{body}", T) == body
assert h(f"FIX YOU (Coldplay)\n\n{body}", T) == body
# labels and a bare "Lyrics"
assert h(f"Title: Fix You\nArtist: Coldplay\n\n{body}", T) == body
assert h(f"Lyrics\n\nFix You\n\n{body}", T) == body
assert h(f"Artist: Coldplay\nTitle: Fix You\n{body}", T) == body
# a title that is the first sung line, running on into the verse, stays
keep = "Fix You\nwhen you try your best"
assert h(keep, T) == keep
assert h(f"Fix You\n{body}", T) == f"Fix You\n{body}"
# nothing to strip
assert h(body, T) == body
# the file's name can be the title
assert h(f"Yellow\nColdplay\n\n{body}", ["Yellow (Live)"]) == body
assert h(f"Yellow\nColdplay\n\n{body}", ["Fix You", "03 Yellow"]) == body
print("lyrics_text ok")
