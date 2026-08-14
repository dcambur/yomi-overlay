#!/usr/bin/env python3
"""Convert Yomitan dictionary zips into one compact lookup index.

Yomitan term banks are arrays of:
  [expression, reading, definitionTags, rules, score, glossary, sequence, termTags]

The overlay needs fast exact lookup by surface form, so we flatten every
expression AND reading into a single map:

  { "見つける": [ {r: "みつける", g: ["to find", ...], s: score}, ... ] }

Frequency dictionaries are folded in as a separate map so senses can be ranked.
"""

import json
import sqlite3
import sys
import zipfile

# MANIFEST lists the dictionaries actually indexed, in priority order. The
# overlay's settings window reads it: without it a dropped-in dictionary lands
# in the database but never appears in the UI, so it can be neither hidden nor
# reordered.
from paths import DICTS, MANIFEST, INDEX_DB as OUT

# Dictionaries contributing definitions, in priority order.
TERM_SOURCES = [
    "jitendex-yomitan.zip",     # JA->EN
    "JMnedict.zip",             # proper names
    "mono-sankoku8.zip",        # 三省堂国語辞典 第八版
    "mono-meikyo2.zip",         # 明鏡国語辞典 第二版
    "mono-oukoku11.zip",        # 旺文社国語辞典 第十一版
    "mono-jitsuyou.zip",        # 実用日本語表現辞典
    "gram-dojg.zip",            # Dictionary of Japanese Grammar
    "gram-donna.zip",           # どんなときどう使う 日本語表現文型辞典
]
PITCH_SOURCES = ["pitch-nhk.zip"]  # NHK 2016

# Display label per dictionary. Order of TERM_SOURCES is also the priority
# order used when ranking senses in the popup.
DICT_LABELS = {
    "jitendex-yomitan.zip": "Jitendex",
    "JMnedict.zip": "Names",
    "mono-sankoku8.zip": "三省堂",
    "mono-meikyo2.zip": "明鏡",
    "mono-oukoku11.zip": "旺文社",
    "mono-jitsuyou.zip": "実用",
    "gram-dojg.zip": "DOJG",
    "gram-donna.zip": "どんなとき",
    "kty-ja-ja.zip": "Wiktionary",
    # lookup.js gates the single-kanji fallback on the label "KANJIDIC", so this
    # name must survive into dictionaries.json unchanged.
    "KANJIDIC_english.zip": "KANJIDIC",
}
FREQ_SOURCES = [
    "JPDB_v2.2_Frequency_Kana_2024-10-13.zip",
    "BCCWJ_SUW_LUW_combined.zip",
]
# Per-kanji dictionaries use kanji_bank_*.json rather than term_bank_*.json.
KANJI_SOURCES = ["KANJIDIC_english.zip"]


def read_json(z, name):
    """Read a bank, tolerating bad CRC-32.

    Some redistributed dictionary archives (NHK 2016 pitch) fail CRC validation
    while containing perfectly valid JSON — repacking artifacts. Refusing them
    would drop a working dictionary for a checksum that no longer matches.
    """
    f = z.open(name)
    f._expected_crc = None
    return json.loads(f.read())


def _text_of(node):
    """Concatenate every string under a structured-content node.

    Ruby annotations ('rt') are skipped: they carry the reading of the base
    text, and inlining them turns 迷惑 into "迷 めい 惑 わく".
    """
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_text_of(n) for n in node)
    if isinstance(node, dict):
        if node.get("tag") == "rt":
            return ""
        if node.get("type") == "text" and "text" in node:
            return node["text"]
        return _text_of(node.get("content"))
    return ""


# Subtrees that are never definition text.
# JMdict/Jitendex marks them with data.content; 三省堂-style monolinguals with
# data.name. Examples, cross-references and attribution links belong to a full
# structured-content renderer, not a three-line popup.
JM_SKIP = {"extra-info", "attribution", "forms", "part-of-speech-info"}
MONO_SKIP = {"見出部", "用例G", "アクセント", "品詞G", "歴史的仮名遣い", "補説G"}
# Trailing link junk some grammar dictionaries append as plain text lines.
_URL_HINTS = ("google.com/", "neocities.org", "http://", "https://")


def _split_plain(text):
    """Break a newline-formatted plain gloss into displayable lines.

    明鏡・旺文社・実用・DOJG ship glosses as one string: headword line, then
    numbered senses (❶/①), then examples. The headword line duplicates the
    term being looked up, so it is dropped; URL lines are noise.
    """
    lines = [ln.strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln and not any(h in ln for h in _URL_HINTS)]
    if lines and ("【" in lines[0] or "読み方：" in lines[0]):
        lines = lines[1:]
    # Bare part-of-speech marker as the leading line (明鏡's 〘名〙) — noise.
    if lines and lines[0].startswith("〘") and lines[0].endswith("〙"):
        lines = lines[1:]

    out = []
    pending_label = ""
    for ln in lines:
        # 明鏡 puts each usage example on its own line (「━政治」); attach it to
        # the sense it illustrates rather than presenting it as a sense.
        if out and ln.startswith("「") and ln.endswith("」"):
            out[-1] += " " + ln
            continue
        # DOJG section labels ([意味], [解説]) head the line that follows them.
        if ln.startswith("[") and ln.endswith("]"):
            pending_label = ln
            continue
        out.append((pending_label + " " + ln) if pending_label else ln)
        pending_label = ""
    return out


def flatten_glossary(gloss):
    """Extract displayable sense lines from a Yomitan glossary.

    Handles the shapes actually present in dicts/:
      - JMdict/Jitendex structured content (data.content markers): one line per
        sense — its number and its glossary items — skipping tags, examples,
        cross-references and attribution.
      - 三省堂-style structured content (data.name markers): one line per 語義,
        numbered, skipping the headword block and examples.
      - Plain newline-formatted strings (明鏡, 旺文社, 実用, DOJG, どんなとき):
        split into lines, headword and URL junk dropped.
    Falls back to the old collect-everything walk for unknown shapes.
    """
    senses = []

    def data_of(d):
        v = d.get("data")
        return v if isinstance(v, dict) else {}

    def gloss_items(d, out):
        """Collect glossary li texts under a JMdict-style node."""
        if isinstance(d, list):
            for x in d:
                gloss_items(x, out)
        elif isinstance(d, dict):
            if data_of(d).get("content") == "glossary":
                items = d.get("content")
                items = items if isinstance(items, list) else [items]
                for li in items:
                    t = _text_of(li).strip()
                    if t:
                        out.append(t)
                return
            gloss_items(d.get("content"), out)

    def walk_jm(d, found):
        """JMdict/Jitendex: emit one line per data.content=='sense' node."""
        if isinstance(d, list):
            for x in d:
                walk_jm(x, found)
        elif isinstance(d, dict):
            data = data_of(d)
            if data.get("content") in JM_SKIP or data.get("class") == "tag":
                return
            if data.get("content") == "sense":
                items = []
                gloss_items(d.get("content"), items)
                if items:
                    # The sense number lives in the node's list style ("①").
                    num = (d.get("style") or {}).get("listStyleType", "")
                    num = num.strip('"')
                    found.append((num + " " if num else "") + "; ".join(items))
                return
            walk_jm(d.get("content"), found)

    def walk_mono(d, found):
        """三省堂-style: emit one line per data.name=='語義' node."""
        if isinstance(d, list):
            for x in d:
                walk_mono(x, found)
        elif isinstance(d, dict):
            data = data_of(d)
            if data.get("name") in MONO_SKIP:
                return
            if data.get("name") == "語義":
                num, text = "", []

                def parts(n):
                    nonlocal num
                    if isinstance(n, list):
                        for x in n:
                            parts(x)
                    elif isinstance(n, dict):
                        nm = data_of(n).get("name")
                        if nm in MONO_SKIP:
                            return
                        if nm == "語義番号":
                            num = _text_of(n.get("content")).strip()
                            return
                        if nm == "語釈":
                            t = _text_of(n.get("content")).strip()
                            if t:
                                text.append(t)
                            return
                        parts(n.get("content"))

                parts(d.get("content"))
                if text:
                    found.append((num + " " if num else "") + " ".join(text))
                return
            walk_mono(d.get("content"), found)

    for g in gloss if isinstance(gloss, list) else [gloss]:
        if isinstance(g, str):
            senses.extend(_split_plain(g))
        elif isinstance(g, dict) and g.get("type") == "structured-content":
            content = g.get("content")
            found = []
            walk_jm(content, found)
            if not found:
                walk_mono(content, found)
            if not found:
                # Unknown structure (どんなとき is one big embedded string).
                t = _text_of(content)
                found = _split_plain(t) if t.strip() else []
            senses.extend(found)

    # Last resort for shapes that produced nothing: the old permissive walk.
    if not senses:
        plains = []

        def walk_any(d):
            if isinstance(d, str):
                plains.append(d)
            elif isinstance(d, list):
                for x in d:
                    walk_any(x)
            elif isinstance(d, dict):
                walk_any(d.get("content"))

        walk_any(gloss)
        senses = [s for s in plains if s.strip().lower() not in TAG_NOISE]

    out, seen = [], set()
    for s in senses:
        s = s.strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out[:8]


# Tokens that appear as standalone fragments alongside real glosses.
TAG_NOISE = {
    "noun", "verb", "adverb", "adjective", "na-adj", "i-adj", "no-adj",
    "pronoun", "particle", "conjunction", "interjection", "prefix", "suffix",
    "counter", "expression", "suru", "transitive", "intransitive", "ichidan",
    "godan", "usually kana", "abbreviation", "colloquial", "archaic",
    "honorific", "humble", "polite", "slang", "obsolete", "rare", "vulgar",
    "christian", "buddhism", "shinto", "medicine", "physics", "chemistry",
    "biology", "mathematics", "computing", "military", "legal", "grammar",
    "jmdict", "jmnedict", "jitendex", "tatoeba", "see also", "|", "｜",
    "forms", "name", "given name", "surname", "place", "company", "product",
}


def load_terms(zpath, db, source_name):
    added = 0
    rows = []
    with zipfile.ZipFile(zpath) as z:
        banks = [n for n in z.namelist() if n.startswith("term_bank")]
        for bank in banks:
            for e in read_json(z, bank):
                if not isinstance(e, list) or len(e) < 6:
                    continue
                expr, reading, score, gloss = e[0], e[1], e[4], e[5]
                glosses = flatten_glossary(gloss)
                if not glosses:
                    continue
                gjson = json.dumps(glosses, ensure_ascii=False)
                # Index under both surface form and reading so kana-only text
                # and kanji text both resolve.
                for key in {expr, reading}:
                    if key:
                        rows.append((key, reading or "", gjson,
                                     score or 0, source_name))
                added += 1
                if len(rows) >= 50000:
                    db.executemany("INSERT INTO terms VALUES (?,?,?,?,?)", rows)
                    rows.clear()
    if rows:
        db.executemany("INSERT INTO terms VALUES (?,?,?,?,?)", rows)
    db.commit()
    return added


def load_kanji(zpath, db):
    """KANJIDIC banks: [character, onyomi, kunyomi, tags, meanings, stats]."""
    rows = []
    with zipfile.ZipFile(zpath) as z:
        for bank in [n for n in z.namelist() if n.startswith("kanji_bank")]:
            for e in read_json(z, bank):
                if not isinstance(e, list) or len(e) < 5:
                    continue
                char, on, kun, _tags, meanings = e[0], e[1], e[2], e[3], e[4]
                if not char:
                    continue
                rows.append((char, on or "", kun or "",
                             json.dumps(meanings or [], ensure_ascii=False)))
    if rows:
        db.executemany("INSERT INTO kanji VALUES (?,?,?,?)", rows)
        db.commit()
    return len(rows)


def load_pitch(zpath, db):
    """NHK banks: [term, "pitch", {reading, pitches:[{position:N}]}]."""
    rows = []
    with zipfile.ZipFile(zpath) as z:
        for bank in [n for n in z.namelist() if n.startswith("term_meta_bank")]:
            for e in read_json(z, bank):
                if not isinstance(e, list) or len(e) < 3 or e[1] != "pitch":
                    continue
                data = e[2]
                if not isinstance(data, dict):
                    continue
                reading = data.get("reading", "")
                for pi in data.get("pitches", []):
                    pos = pi.get("position")
                    if isinstance(pos, int):
                        rows.append((e[0], reading, pos))
    if rows:
        db.executemany("INSERT INTO pitch VALUES (?,?,?)", rows)
        db.commit()
    return len(rows)


def load_freq(zpath, freq):
    with zipfile.ZipFile(zpath) as z:
        for bank in [n for n in z.namelist() if n.startswith("term_meta_bank")]:
            for e in read_json(z, bank):
                if not isinstance(e, list) or len(e) < 3 or e[1] != "freq":
                    continue
                term, val = e[0], e[2]
                if isinstance(val, dict):
                    val = val.get("value") or val.get("frequency")
                    if isinstance(val, dict):
                        val = val.get("value")
                if isinstance(val, int):
                    prev = freq.get(term)
                    if prev is None or val < prev:
                        freq[term] = val


def classify(zpath):
    """Work out what kind of Yomitan dictionary a zip is, and its title.

    The named source lists below are only a *priority* order. Anything else the
    user drops into dicts/ is identified here by the banks it contains, so a
    third-party dictionary is indexed rather than silently ignored.
    """
    try:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            title = ""
            if "index.json" in names:
                try:
                    title = (json.loads(z.read("index.json")).get("title") or "").strip()
                except Exception:
                    pass
            if any(n.startswith("kanji_bank") for n in names):
                return "kanji", title
            if any(n.startswith("term_bank") for n in names):
                return "term", title
            # freq and pitch banks are indistinguishable by filename; the tag
            # sits in the second element of each record.
            metas = [n for n in names if n.startswith("term_meta_bank")]
            for bank in metas[:1]:
                kinds = {e[1] for e in read_json(z, bank)[:500]
                         if isinstance(e, list) and len(e) >= 2}
                if "pitch" in kinds:
                    return "pitch", title
                if "freq" in kinds:
                    return "freq", title
    except Exception as e:
        print(f"  ! {zpath.name}: cannot read ({e})")
    return None, ""


def discover():
    """Group every zip in dicts/ by kind, named sources first."""
    named = {
        "term": list(TERM_SOURCES),
        "kanji": list(KANJI_SOURCES),
        "pitch": list(PITCH_SOURCES),
        "freq": list(FREQ_SOURCES),
    }
    known = {n for group in named.values() for n in group}
    found = {k: [n for n in v if (DICTS / n).exists()] for k, v in named.items()}

    for p in sorted(DICTS.glob("*.zip")):
        if p.name in known:
            continue
        kind, title = classify(p)
        if kind is None:
            print(f"  ? {p.name:<34} not a recognisable Yomitan dictionary — skipped")
            continue
        DICT_LABELS.setdefault(p.name, title or p.stem)
        found[kind].append(p.name)
        print(f"  + {p.name:<34} discovered as {kind}"
              + (f' — "{DICT_LABELS[p.name]}"' if kind in ("term", "kanji") else ""))
    return found


def create_schema(db):
    """The shape of an index built by this script.

    A function rather than a literal inside main() so a test can build a small
    index in this shape without reproducing it — lookup.js still reads indexes
    built here, and a hand-copied CREATE TABLE in a test would drift from the
    thing it claims to describe the moment either side changed.
    """
    db.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE terms (key TEXT, reading TEXT, gloss TEXT, score INT, dict TEXT);
        CREATE TABLE freq  (term TEXT, source TEXT, value INT);
        CREATE TABLE kanji (char TEXT PRIMARY KEY, on_yomi TEXT, kun_yomi TEXT, meanings TEXT);
        CREATE TABLE pitch (term TEXT, reading TEXT, position INT);
    """)


def main():
    if not DICTS.exists():
        print("no dicts/ — run fetch-dicts.py first")
        return 1

    sources = discover()

    OUT.unlink(missing_ok=True)
    db = sqlite3.connect(OUT)
    create_schema(db)

    # Labels in the order they are loaded — the popup's default sense priority
    # and the order shown in the settings window.
    labels = []

    for name in sources["term"]:
        label = DICT_LABELS.get(name, name.split(".")[0])
        n = load_terms(DICTS / name, db, label)
        if n:
            labels.append(label)
        print(f"  {name:<34} {n:>7} entries")

    for name in sources["kanji"]:
        n = load_kanji(DICTS / name, db)
        if n:
            labels.append(DICT_LABELS.get(name, "KANJIDIC"))
        print(f"  {name:<34} {n:>7} kanji")

    for name in sources["pitch"]:
        n = load_pitch(DICTS / name, db)
        print(f"  {name:<34} {n:>7} pitch records")

    for name in sources["freq"]:
        freq = {}
        load_freq(DICTS / name, freq)
        label = name.split("_")[0]
        db.executemany("INSERT INTO freq VALUES (?,?,?)",
                       ((t, label, v) for t, v in freq.items()))
        db.commit()
        print(f"  {name:<34} {len(freq):>7} frequency records")

    # Index last — far faster than maintaining it during bulk insert.
    print("\nbuilding index…")
    db.execute("CREATE INDEX idx_terms_key ON terms(key)")
    db.execute("CREATE INDEX idx_freq_term ON freq(term)")
    db.execute("CREATE INDEX idx_pitch_term ON pitch(term)")
    db.commit()
    rows = db.execute("SELECT COUNT(*) FROM terms").fetchone()[0]
    keys = db.execute("SELECT COUNT(DISTINCT key) FROM terms").fetchone()[0]
    db.execute("VACUUM")
    db.close()

    MANIFEST.write_text(json.dumps(labels, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")

    print(f"rows: {rows}   unique surface forms: {keys}")
    print(f"wrote {OUT} ({OUT.stat().st_size/1048576:.1f} MB)")
    print(f"wrote {MANIFEST.name}: {', '.join(labels)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
