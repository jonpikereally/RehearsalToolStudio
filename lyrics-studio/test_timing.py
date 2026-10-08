"""Checks for timing.py — run with: python3 lyrics-studio/test_timing.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import timing

FR = 100.0  # frames per second


def env(*sung, total=20.0):
    """An envelope loud in the given (start, end) seconds, quiet elsewhere."""
    out = [0.001] * int(total * FR)
    for a, b in sung:
        for i in range(int(a * FR), int(b * FR)):
            out[i] = 1.0
    return out


def seg(*words):
    ws = [{"text": t, "start": a, "end": b} for t, a, b in words]
    return {"text": " ".join(w["text"] for w in ws), "start": ws[0]["start"], "end": ws[-1]["end"], "words": ws}


def near(a, b, tol=0.03):
    return abs(a - b) <= tol


# runs: found, with breaths bridged and blips dropped
runs = timing.voiced_runs(env((1, 3), (3.1, 4), (10, 12), (15, 15.03)), FR)
assert len(runs) == 2, runs
assert near(runs[0][0], 1) and near(runs[0][1], 4) and near(runs[1][0], 10), runs
assert timing.voiced_runs([], FR) == [] and timing.voiced_runs([0.0] * 50, FR) == []

# a word held through a break is pulled back to where it stops
s = timing.fit_to_voice([seg(("la", 1.0, 2.0), ("la", 2.0, 9.9)), seg(("hey", 10.0, 11.0))], runs)
assert near(s[0]["words"][1]["end"], 4.0), s
assert near(s[1]["words"][0]["start"], 10.0)

# the first word after a break, pulled back into it, is pushed forward again
s = timing.fit_to_voice([seg(("a", 1.0, 3.0)), seg(("b", 5.0, 11.0))], runs)
assert near(s[1]["words"][0]["start"], 10.0) and near(s[1]["start"], 10.0), s

# words invented in a break go; so do segments left empty
s = timing.drop_unvoiced([seg(("la", 1.0, 2.0)), seg(("Thank", 6.0, 6.5), ("you", 6.5, 7.0)), seg(("hey", 10.0, 11.0))], runs)
assert [x["text"] for x in s] == ["la", "hey"], s

# lyrics with nothing heard to take a time from follow the singing, not the break
w = timing.spread_over_voice(3.0, 11.0, 2, runs)
assert w[0][0] >= 3.0 and w[0][1] <= 4.01 or w[0][0] >= 10 - 0.01, w
assert all(a >= 3.0 - 1e-9 and b <= 11.0 + 1e-9 and (b <= 4.01 or a >= 9.99) for a, b in w), w
# ...and with no runs known, evenly as before
assert timing.spread_over_voice(0, 4, 4, []) == [(0, 1), (1, 2), (2, 3), (3, 4)]

# the whole path, with nothing known, leaves timing alone
base = [seg(("a", 1.0, 2.0), ("b", 2.0, 30.0))]
assert timing.fit_to_voice(base, [])[0]["words"][1]["end"] == 30.0
print("timing ok")
