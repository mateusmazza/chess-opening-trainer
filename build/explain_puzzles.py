"""
Why the solution works: the explanation shown when a puzzle ends.

A puzzle that ends with "Correct!" and jumps to the next one teaches you that
a move was right, not WHY -- and the why is the part that transfers to the
next game. So every puzzle card is annotated here, at build time, with the
same layers the opening moves carry (see explain.py):

  edge.facts    what each move does on the board (captures, checks, pins,
                attacks something loose...). Pure geometry, never wrong.
  edge.threat   what the move threatens if ignored, from Stockfish. This is
                what explains a QUIET solution move, the kind that has no
                capture or check to point at.
  card.why      the line as a whole:
                  outcome  what the line wins: "Checkmate", "You win the
                           queen for a rook", "Promotes to a queen".
                  played   (your own blunders only) what your actual move
                           allowed: {"san", "reply", "facts"}.

Only fields are ADDED. Card ids, edges and their order are untouched, so
saved progress keyed on card ids stays valid.

Run on its own to annotate the exercises already in the app, without
rebuilding them from your games:

  python3 build/explain_puzzles.py            # uses Stockfish if found
  python3 build/explain_puzzles.py --no-engine

build_exercises.py calls annotate_payload() itself, so a refresh keeps the
explanations. Engine findings are cached in data/puzzle_threats.json
(gitignored, like the rest of your game data).
"""

import json
import logging
import os
import sys

import chess
import chess.engine

import explain
from themes import _recapture_value

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, os.pardir)
EXERCISES = os.path.join(ROOT, "app", "exercises.js")
CACHE = os.path.join(ROOT, "data", "puzzle_threats.json")
PREFIX = "window.EXERCISES = "

# python-chess warns on every null-move search ("Not transmitting history with
# null moves"), which is exactly how a threat is found. Expected; hush it.
logging.getLogger("chess.engine").setLevel(logging.ERROR)

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5,
         chess.QUEEN: 9}
NAMES = explain.NAMES


def _material(board, color):
    return sum(VALUE.get(p.piece_type, 0)
               for p in board.piece_map().values() if p.color == color)


def _list(names):
    """['queen'] -> 'the queen'; ['knight', 'pawn', 'pawn'] -> 'a knight and
    two pawns'. `names` arrives sorted most valuable first."""
    counts = {}
    for n in names:
        counts[n] = counts.get(n, 0) + 1
    words = []
    for n, k in counts.items():
        if k == 1:
            words.append(f"the {n}" if n == "queen" else f"a {n}")
        else:
            words.append(f"{NUMBER.get(k, k)} {n}s")
    if not words:
        return ""
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


NUMBER = {2: "two", 3: "three", 4: "four", 5: "five"}

# Phrases from explain.facts that describe opening development. True of a
# queen leaving d8 on move 4, misleading about one leaving d8 on move 30.
OPENING_ONLY = ("Brings the queen out", "Develops the", "Clears the way to castle",
                "Puts a pawn in the centre")


def outcome(start_fen, edges, solver):
    """One sentence on what the solution line achieves, or None when it is not
    about material (a defensive or positional puzzle -- then the per-move
    threats carry the explanation)."""
    board = chess.Board(start_fen)
    won, lost, promoted = [], [], False
    for e in edges:
        mv = chess.Move.from_uci(e["uci"])
        mover = board.turn
        if board.is_en_passant(mv):
            victim = chess.PAWN
        else:
            p = board.piece_at(mv.to_square)
            victim = p.piece_type if p else None
        if victim:
            (won if mover == solver else lost).append(victim)
        if mv.promotion and mover == solver:
            promoted = True
        board.push(mv)

    if board.is_checkmate():
        return "It ends in checkmate."

    # cancel like-for-like trades: "a knight for a knight" is not a gain
    for t in list(won):
        if t in lost:
            won.remove(t)
            lost.remove(t)
    gain = sum(VALUE[t] for t in won) - sum(VALUE[t] for t in lost)
    # The line can stop on a capture that is about to be taken back. Count
    # that recapture, or "you win the queen" is a lie.
    last = chess.Move.from_uci(edges[-1]["uci"])
    pending = _recapture_value(board, last.to_square) if board.piece_at(last.to_square) else 0
    net = gain - pending

    parts = []
    if net > 0 and won:
        won.sort(key=lambda t: -VALUE[t])
        lost.sort(key=lambda t: -VALUE[t])
        w = _list([NAMES[t] for t in won])
        if lost:
            parts.append(f"You win {w} for {_list([NAMES[t] for t in lost])}"
                         f" — a net gain of {net} point{'s' if net != 1 else ''}.")
        else:
            parts.append(f"You win {w}.")
        if pending:
            parts[-1] = parts[-1][:-1] + ", even after they take back."
    if promoted:
        parts.append("Your pawn promotes to a queen.")
    if board.is_check() and not parts:
        parts.append("They are left in check with nothing good to do.")
    return " ".join(parts) or None


def _played_reply(start_fen, edges, played_san, threats):
    """For your own blunders: what did the move you actually played allow?
    The position you erred in is the one just before your first move."""
    board = chess.Board(start_fen)
    for e in edges:
        if e["mine"]:
            break
        board.push(chess.Move.from_uci(e["uci"]))
    try:
        mv = board.parse_san(played_san)
    except ValueError:
        return None
    board.push(mv)
    if board.is_game_over():
        return None
    reply = threats.best_reply(board)
    if reply is None:
        return None
    return {"san": played_san, "reply": board.san(reply),
            "facts": [f for f in explain.facts(board, reply)
                      if not f.startswith(OPENING_ONLY)]}


class PuzzleThreats(explain.Threats):
    """Threats, plus the engine's best reply to a position (cached alongside)."""

    def best_reply(self, board):
        key = "best " + board.epd()
        if key in self.cache:
            uci = self.cache[key]
            return chess.Move.from_uci(uci) if uci else None
        eng = self._engine_or_none()
        if eng is None:
            self.misses += 1
            return None
        info = eng.analyse(board, chess.engine.Limit(depth=self.depth))
        pv = info.get("pv") or []
        self.cache[key] = pv[0].uci() if pv else None
        self.dirty = True
        return pv[0] if pv else None


def annotate_card(card, threats):
    solver = chess.WHITE if card["color"] == "white" else chess.BLACK
    board = chess.Board(card["startFen"])
    prev, prev_cap = None, False
    for e in card["edges"]:
        mv = chess.Move.from_uci(e["uci"])
        e["facts"] = [f for f in explain.facts(board, mv, prev, prev_cap)
                      if not f.startswith(OPENING_ONLY)]
        after = board.copy(stack=False)
        after.push(mv)
        t = threats.threat(after)
        if t:
            e["threat"] = t
        else:
            e.pop("threat", None)
        prev, prev_cap = mv, board.is_capture(mv)
        board = after

    why = {}
    o = outcome(card["startFen"], card["edges"], solver)
    if o:
        why["outcome"] = o
    meta = card.get("meta") or {}
    if meta.get("kind") == "own" and meta.get("played"):
        p = _played_reply(card["startFen"], card["edges"], meta["played"], threats)
        if p:
            why["played"] = p
    if why:
        card["why"] = why
    else:
        card.pop("why", None)


def _all_cards(payload):
    for pack in payload.get("packs", []):
        yield from pack["items"]
    for lesson in payload.get("lessons", []):
        for stage in lesson["stages"]:
            yield from stage["cards"]


def make_threats(allow_engine=True):
    engine_path = None
    if allow_engine:
        try:
            import conf
            from analyze_games import find_engine
            engine_path = find_engine(conf.load().get("engine", {}).get("path"))
        except Exception:
            engine_path = None
    return PuzzleThreats(engine_path=engine_path, allow_engine=allow_engine,
                         path=CACHE, depth=12,
                         comment="Threats and best replies for puzzle positions "
                                 "(build/explain_puzzles.py). Personal: gitignored.")


def annotate_payload(payload, allow_engine=True, verbose=False):
    threats = make_threats(allow_engine)
    try:
        cards = list(_all_cards(payload))
        for i, c in enumerate(cards):
            annotate_card(c, threats)
            if verbose and (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(cards)} puzzles explained", flush=True)
    finally:
        threats.close()
    return len(cards), threats.misses


def main():
    allow = "--no-engine" not in sys.argv
    if not os.path.exists(EXERCISES):
        print("No app/exercises.js yet -- run build/refresh.sh first.")
        return 1
    with open(EXERCISES, encoding="utf-8") as fh:
        text = fh.read()
    i = text.index(PREFIX)
    header, body = text[:i], text[i + len(PREFIX):].rstrip().rstrip(";")
    payload = json.loads(body)
    ids_before = [c["id"] for c in _all_cards(payload)]
    n, misses = annotate_payload(payload, allow_engine=allow, verbose=True)
    assert [c["id"] for c in _all_cards(payload)] == ids_before
    with open(EXERCISES, "w", encoding="utf-8") as fh:
        fh.write(header + PREFIX)
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"[ OK ] explained {n} puzzles"
          + (f" ({misses} positions had no engine finding)" if misses else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
