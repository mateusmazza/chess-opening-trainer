"""
Did the training reach the board? Your repertoire, checked against your games.

The trainer measures whether you can recall a move when it asks. That is not
the goal -- the goal is playing it in a real game, on a clock, against a real
opponent, and those are different skills. This script measures the second one.

It walks every game in data/games/index.json through the repertoire. At each
position where the repertoire has a move for you, it records whether you
played it:

  reached   how often you were in that position as the side to move
  played    what you actually played there, move -> count
  lastMiss  the most recent game where you played something else (with a link)

A game stops being followed at the first move that leaves the repertoire. If
the OPPONENT leaves it, that is not your mistake and nothing is counted
against you. If YOU leave it, that position is a leak: the app lists your
leaks next to your trouble spots and drills them, and it charts, month by
month, the share of your games in which you stayed on book for as long as your
opponent did. That chart is the honest answer to "is this training working?"

Output: app/mygames.js (window.MYGAMES), gitignored -- it is your game history.
Absent, the app simply does not show the real-games panel.

  python3 build/game_moves.py
"""

import io
import json
import os
import time
from collections import defaultdict

import chess
import chess.pgn

from repertoire import REPERTOIRE

HERE = os.path.dirname(os.path.abspath(__file__))
GAMES = os.path.join(HERE, os.pardir, "data", "games", "index.json")
OUT = os.path.join(HERE, os.pardir, "app", "mygames.js")

# Lines in the repertoire run to about 24 plies; nothing deeper can match.
MAX_PLIES = 30
# "Recent" for the per-move counts the app uses to decide what is still a leak.
RECENT_DAYS = 60


def book_by_color():
    """color -> {path-before-my-move: set of my book moves}.

    Merged across every course of that colour, because in a real game you do
    not announce which course you are in: after 1.e4 e5 2.Nf3 Nc6 the Italian,
    Scotch and Ruy Lopez are all your book, and any of them is "right".
    """
    out = {"white": defaultdict(set), "black": defaultdict(set)}
    for course in REPERTOIRE:
        me = chess.WHITE if course["color"] == "white" else chess.BLACK
        for line in course["lines"]:
            board = chess.Board()
            path = []
            for san in line.split():
                if board.turn == me:
                    out[course["color"]][" ".join(path)].add(san)
                board.push_san(san)
                path.append(san)
    return out


def game_sans(pgn):
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return []
    board = game.board()
    out = []
    for mv in game.mainline_moves():
        if len(out) >= MAX_PLIES:
            break
        out.append(board.san(mv))
        board.push(mv)
    return out


def main():
    if not os.path.exists(GAMES):
        print("no games downloaded yet -- run build/fetch_games.py first")
        return
    with open(GAMES, encoding="utf-8") as fh:
        games = json.load(fh).get("games", [])

    book = book_by_color()
    # all positions on any line, so we can tell "opponent left the tree"
    known = {"white": set(), "black": set()}
    for course in REPERTOIRE:
        for line in course["lines"]:
            sans = line.split()
            for i in range(len(sans) + 1):
                known[course["color"]].add(" ".join(sans[:i]))

    now = time.time()
    moves = {}
    monthly = defaultdict(lambda: {"games": 0, "clean": 0})

    for g in games:
        color = g.get("color")
        if color not in book or not g.get("pgn"):
            continue
        try:
            sans = game_sans(g["pgn"])
        except Exception:
            continue
        me_first = color == "white"
        end = int(g.get("end_time") or 0)
        recent = (now - end) < RECENT_DAYS * 86400
        month = time.strftime("%Y-%m", time.localtime(end)) if end else "?"

        reached_any = False
        deviated = False
        path = []
        for ply, san in enumerate(sans):
            key = " ".join(path)
            my_turn = (ply % 2 == 0) == me_first
            if my_turn:
                if key not in book[color]:
                    break                       # past the end of your lines
                reached_any = True
                rec = moves.setdefault(f"{color}|{key}", {
                    "book": sorted(book[color][key]), "reached": 0, "played": {},
                    "recentReached": 0, "recentBook": 0})
                rec["reached"] += 1
                rec["played"][san] = rec["played"].get(san, 0) + 1
                on_book = san in book[color][key]
                if recent:
                    rec["recentReached"] += 1
                    rec["recentBook"] += 1 if on_book else 0
                if not on_book:
                    last = rec.get("lastMiss")
                    if not last or end > last["t"]:
                        rec["lastMiss"] = {"san": san, "url": g.get("url"), "t": end}
                    deviated = True
                    break
            path.append(san)
            if not my_turn and " ".join(path) not in known[color]:
                break                               # opponent left the book
        if reached_any:
            monthly[month]["games"] += 1
            monthly[month]["clean"] += 0 if deviated else 1

    payload = {
        "generated": int(now),
        "games": len(games),
        "moves": moves,
        "monthly": [{"month": m, **v} for m, v in sorted(monthly.items()) if m != "?"],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// AUTO-GENERATED by build/game_moves.py from your own games.\n")
        fh.write("// Personal data: gitignored.\n")
        fh.write("window.MYGAMES = ")
        fh.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        fh.write(";\n")

    leaks = sorted(((k, v) for k, v in moves.items()
                    if any(s not in v["book"] for s in v["played"])),
                   key=lambda kv: -sum(n for s, n in kv[1]["played"].items()
                                       if s not in kv[1]["book"]))
    print(f"Wrote {OUT}: {len(moves)} repertoire positions reached in your games.")
    print("Months (games reaching your repertoire / stayed on book):")
    for m in payload["monthly"]:
        print(f"  {m['month']}  {m['games']:3}  {m['clean']:3}  "
              f"{round(100 * m['clean'] / m['games'])}%")
    print("Where you most often leave your own repertoire:")
    for k, v in leaks[:10]:
        color, path = k.split("|", 1)
        wrong = {s: n for s, n in v["played"].items() if s not in v["book"]}
        print(f"  {color:5} after {path or '(start)':38} book {'/'.join(v['book']):12}"
              f" you played {wrong}  (reached {v['reached']})")


if __name__ == "__main__":
    main()
