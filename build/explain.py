"""
Why each move is played: the explanations the trainer shows on every move.

Memorising a move order without knowing what each move is FOR is the most
fragile kind of memory there is -- it is a phone number. Tie every move to a
reason and you can rebuild a forgotten move from the idea, and you recognise
the same idea in positions the repertoire never showed you. So every edge of
the repertoire tree carries three layers of explanation:

  note      a sentence written for that exact move (build/move_notes.json):
            the plan behind it, in words a club player would use.
  cue       for YOUR moves, the same idea phrased as a question that does not
            give the move away. The app shows it as the first hint, so a
            forgotten move is retrieved from its idea before it is shown.
  facts     what the move does on the board, computed here with python-chess:
            develops, captures, attacks, pins, defends, clears castling...
            Geometry, not opinion, so it is never wrong -- and it covers every
            move even where no note has been written yet.
  threat    what the move threatens if ignored, from Stockfish: the position
            after the move is searched as if the other side passed. For the
            opponent's moves this is the single most useful thing a beginner
            can be told ("they threaten Qxf7#"). Cached in
            build/engine_threats.json, which is tracked like
            engine_verified.json: a clone needs no engine to get the threats.

Nothing here can fail the build. A missing note or an unavailable engine just
means that layer is absent for that move.
"""

import json
import os

import chess

HERE = os.path.dirname(os.path.abspath(__file__))
NOTES_PATH = os.path.join(HERE, "move_notes.json")
THREATS_PATH = os.path.join(HERE, "engine_threats.json")

NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
         chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}
VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5,
         chess.QUEEN: 9, chess.KING: 100}
CENTRE = [chess.D4, chess.E4, chess.D5, chess.E5]

# A threat must win at least this much over the best defence to be worth
# naming. Below it the "threat" is a positional nudge, not something to see.
THREAT_MIN_CP = 150
THREAT_DEPTH = 14


# ----------------------------------------------------------------------------
# hand-written notes
# ----------------------------------------------------------------------------

def load_notes():
    """path -> {"note": str, "cue": str?}. Path is the SAN sequence from the
    start position up to AND INCLUDING the move, space separated."""
    if not os.path.exists(NOTES_PATH):
        return {}
    with open(NOTES_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    return {k: v for k, v in raw.items() if not k.startswith("_")}


# ----------------------------------------------------------------------------
# facts: pure board geometry
# ----------------------------------------------------------------------------

def _piece_on(board, sq):
    p = board.piece_at(sq)
    return f"{NAMES[p.piece_type]} on {chess.square_name(sq)}"


def _attacked_enemies(board, color):
    """Enemy (non-king) squares attacked by `color` in this position."""
    out = set()
    for sq, p in board.piece_map().items():
        if p.color != color and p.piece_type != chess.KING \
                and board.is_attacked_by(color, sq):
            out.add(sq)
    return out


def _loose(board, sq):
    """Is the piece on sq attacked and either undefended or attacked by
    something cheaper? (i.e. would capturing it actually win material)"""
    p = board.piece_at(sq)
    attackers = board.attackers(not p.color, sq)
    if not attackers:
        return False
    if not board.attackers(p.color, sq):
        return True
    cheapest = min(VALUE[board.piece_at(a).piece_type] for a in attackers)
    return cheapest < VALUE[p.piece_type]


def _castle_path_clear(board, color, side):
    rank = 0 if color == chess.WHITE else 7
    files = [5, 6] if side == "king" else [1, 2, 3]
    return all(board.piece_at(chess.square(f, rank)) is None for f in files)


def _has_rights(board, color, side):
    return (board.has_kingside_castling_rights(color) if side == "king"
            else board.has_queenside_castling_rights(color))


def _mobility(board, sq):
    return len(board.attacks(sq))


def facts(board, move, prev_move=None, prev_capture=False):
    """Short factual phrases about `move` played in `board` (position BEFORE
    the move), from the mover's point of view. At most four, most important
    first. `prev_capture` says whether `prev_move` took something -- only then
    is taking back on the same square a recapture."""
    me = board.turn
    piece = board.piece_at(move.from_square)
    kind = piece.piece_type
    to = move.to_square
    to_name = chess.square_name(to)
    out = []

    after = board.copy(stack=False)
    after.push(move)

    # -- castling ------------------------------------------------------------
    if board.is_castling(move):
        side = "kingside" if chess.square_file(to) > 4 else "queenside"
        out.append(f"Castles {side}: the king is safe and the rook joins the game")

    # -- captures ------------------------------------------------------------
    elif board.is_capture(move):
        if board.is_en_passant(move):
            out.append("Captures en passant")
        else:
            victim = NAMES[board.piece_at(to).piece_type]
            if prev_capture and prev_move is not None and prev_move.to_square == to:
                out.append(f"Recaptures on {to_name}, winning back the {victim}")
            else:
                out.append(f"Captures the {victim} on {to_name}")

    # -- development -----------------------------------------------------------
    home_rank = 0 if me == chess.WHITE else 7
    if kind in (chess.KNIGHT, chess.BISHOP) \
            and chess.square_rank(move.from_square) == home_rank \
            and not board.is_capture(move):
        central = 2 <= chess.square_file(to) <= 5
        out.append(f"Develops the {NAMES[kind]}"
                   + (" toward the centre" if central and kind == chess.KNIGHT else ""))
    elif kind == chess.QUEEN and move.from_square in (chess.D1, chess.D8):
        out.append("Brings the queen out")

    # -- centre pawns ----------------------------------------------------------
    if kind == chess.PAWN and to in CENTRE and not board.is_capture(move):
        out.append(f"Puts a pawn in the centre on {to_name}")

    # -- check -----------------------------------------------------------------
    if after.is_check():
        out.append("Gives check")

    # -- pins created ----------------------------------------------------------
    for sq, p in after.piece_map().items():
        if p.color != me and p.piece_type not in (chess.KING, chess.PAWN) \
                and after.is_pinned(not me, sq) and not board.is_pinned(not me, sq):
            out.append(f"Pins the {_piece_on(after, sq)} to the king")
            break

    # -- new attacks (including discovered ones) ------------------------------
    before_att = _attacked_enemies(board, me)
    new_att = sorted(_attacked_enemies(after, me) - before_att,
                     key=lambda s: -VALUE[after.piece_at(s).piece_type])
    # the piece we just took is not "attacked"; a pinned piece is reported above
    new_att = [s for s in new_att if s != to
               and not (after.is_pinned(not me, s) and not board.is_pinned(not me, s))]
    # Only attacks that threaten to win something: hitting a defended piece
    # with something worth more is geometry, not an idea, and listing it
    # buries the attacks that matter.
    for sq in [s for s in new_att if _loose(after, s)][:2]:
        p = after.piece_at(sq)
        guarded = bool(after.attackers(p.color, sq))
        out.append(f"Attacks the {_piece_on(after, sq)}"
                   + (" with a cheaper piece" if guarded else ", which is undefended"))

    # -- moving an attacked piece to safety ---------------------------------------
    if kind != chess.PAWN and kind != chess.KING and not board.is_castling(move) \
            and board.is_attacked_by(not me, move.from_square) \
            and _loose(board, move.from_square) and not _loose(after, to):
        out.append(f"Moves the attacked {NAMES[kind]} to safety")

    # -- defending a loose piece -----------------------------------------------
    for sq, p in board.piece_map().items():
        if p.color == me and sq != move.from_square and p.piece_type != chess.KING \
                and _loose(board, sq) and not _loose(after, sq) \
                and len(after.attackers(me, sq)) > len(board.attackers(me, sq)):
            # a real new defender -- not merely the attacker disappearing
            out.append(f"Defends the {_piece_on(board, sq)}")
            break

    # -- clears the way to castle ------------------------------------------------
    if not board.is_castling(move) and kind != chess.KING:
        for side in ("king", "queen"):
            if _has_rights(after, me, side) and not _castle_path_clear(board, me, side) \
                    and _castle_path_clear(after, me, side):
                out.append(f"Clears the way to castle {side}side")

    # -- opens lines for the long-range pieces -----------------------------------
    if kind == chess.PAWN:
        for sq, p in board.piece_map().items():
            if p.color == me and p.piece_type in (chess.BISHOP, chess.QUEEN):
                gain = _mobility(after, sq) - _mobility(board, sq)
                if gain >= 2:
                    out.append(f"Opens a line for the {_piece_on(board, sq)}")
                    break

    # -- pawn control of the centre (c3 -> d4, e6 -> d5 ...) --------------------
    if kind == chess.PAWN and to not in CENTRE and not board.is_capture(move):
        newly = [s for s in CENTRE
                 if s in after.attacks(to) and s not in board.attacks(move.from_square)
                 and not (after.piece_at(s) and after.piece_at(s).color == me)]
        if newly:
            out.append(f"Takes control of {', '.join(chess.square_name(s) for s in newly)}")

    # de-duplicate while keeping order
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq[:4]


# ----------------------------------------------------------------------------
# threats: what does this move threaten if the other side ignores it?
# ----------------------------------------------------------------------------

def _load_threats():
    if not os.path.exists(THREATS_PATH):
        return {}
    try:
        with open(THREATS_PATH, encoding="utf-8") as fh:
            return json.load(fh).get("threats", {})
    except (OSError, ValueError):
        return {}


class Threats:
    """Stockfish threat detection, memoised on disk like verify_engine.

    A threat is computed on the position AFTER a move: we let the mover move
    again (a null move for the defender) and ask whether that gains at least
    THREAT_MIN_CP over what they have when the defender replies normally.
    """

    def __init__(self, engine_path=None, allow_engine=True):
        self.cache = _load_threats()
        self.engine_path = engine_path
        self.allow_engine = allow_engine
        self.dirty = False
        self.misses = 0
        self._engine = None

    def _engine_or_none(self):
        if self._engine is not None:
            return self._engine
        if not self.allow_engine or not self.engine_path:
            return None
        import chess.engine
        self._engine = chess.engine.SimpleEngine.popen_uci(self.engine_path)
        self._engine.configure({"Threads": 4, "Hash": 256})
        return self._engine

    def close(self):
        if self._engine is not None:
            self._engine.quit()
            self._engine = None
        if self.dirty:
            payload = {
                "_comment": "What each repertoire move threatens, from Stockfish "
                            "(see build/explain.py). Tracked so a fresh clone "
                            "needs no engine.",
                "depth": THREAT_DEPTH, "min_cp": THREAT_MIN_CP,
                "threats": dict(sorted(self.cache.items())),
            }
            with open(THREATS_PATH, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=1)
                fh.write("\n")

    def threat(self, after):
        """`after` is the position after the move; the defender is to move.
        Returns a phrase such as 'Qxf7#' or 'Bxd4, winning the knight', or
        None. The cache keeps the raw engine finding, so how threats are
        worded can change without re-running Stockfish."""
        if after.is_check() or after.is_game_over():
            return None          # in check the defender cannot "pass"
        key = after.epd()
        if key in self.cache:
            return self._phrase(self.cache[key])
        eng = self._engine_or_none()
        if eng is None:
            self.misses += 1
            return None

        import chess.engine
        limit = chess.engine.Limit(depth=THREAT_DEPTH)
        attacker = not after.turn

        normal = eng.analyse(after, limit)["score"].pov(attacker).score(mate_score=10000)
        passed = after.copy(stack=False)
        passed.push(chess.Move.null())
        info = eng.analyse(passed, limit)
        pv = info.get("pv") or []
        gain = info["score"].pov(attacker).score(mate_score=10000) - normal

        result = None
        if pv:
            mv = pv[0]
            victim = passed.piece_at(mv.to_square)
            mate = info["score"].pov(attacker).mate()
            result = {"san": passed.san(mv), "gain": gain,
                      "mate": mate if mate is not None and mate > 0 else None,
                      "victim": (NAMES[victim.piece_type]
                                 if victim is not None and passed.is_capture(mv)
                                 else None)}
        self.cache[key] = result
        self.dirty = True
        return self._phrase(result)

    @staticmethod
    def _phrase(raw):
        """Raw engine finding -> the words shown, or None. Only concrete
        threats are named: a mate, or a capture or check that wins material.
        A quiet "threat" (an engine liking Re1 more) is not something a player
        can be expected to see, and naming it only teaches noise."""
        if not raw:
            return None
        san = raw["san"]
        if raw.get("mate"):
            return san if san.endswith("#") else f"{san}, with a mating attack"
        if raw["gain"] < THREAT_MIN_CP:
            return None
        if san.endswith("+"):
            return san          # a check is the point, whatever it also takes
        if raw.get("victim"):
            article = "a" if raw["victim"] == "pawn" else "the"
            return f"{san}, winning {article} {raw['victim']}"
        return None


# ----------------------------------------------------------------------------
# tree annotation (called from generate.py)
# ----------------------------------------------------------------------------

def annotate(root, notes, threats):
    """Attach note/cue/facts/threat to every edge of a course tree, in place.
    Returns the number of edges that have no hand-written note."""
    missing = 0

    def walk(node, board, path, prev_move, prev_capture):
        nonlocal missing
        for edge in node["children"].values():
            move = chess.Move.from_uci(edge["uci"])
            key = " ".join(path + [edge["san"]])
            n = notes.get(key)
            if n:
                edge["note"] = n["note"]
                if edge["mine"] and n.get("cue"):
                    edge["cue"] = n["cue"]
            else:
                missing += 1
            edge["facts"] = facts(board, move, prev_move, prev_capture)
            after = board.copy(stack=False)
            after.push(move)
            t = threats.threat(after) if threats is not None else None
            if t:
                edge["threat"] = t
            walk(edge["node"], after, path + [edge["san"]], move,
                 board.is_capture(move))

    walk(root, chess.Board(), [], None, False)
    return missing


if __name__ == "__main__":
    # Quick look at what a line produces: python3 build/explain.py e4 e5 Nf3
    import sys
    b = chess.Board()
    prev, prev_cap = None, False
    for san in sys.argv[1:]:
        mv = b.parse_san(san)
        print(f"{san:8} {facts(b, mv, prev, prev_cap)}")
        prev, prev_cap = mv, b.is_capture(mv)
        b.push(mv)
