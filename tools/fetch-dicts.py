#!/usr/bin/env python3
"""Download Japanese dictionaries in Yomitan format.

Only freely-licensed sources: JMdict/JMnedict/KANJIDIC (EDRDG, CC BY-SA) and
Wiktionary-derived monolingual (CC BY-SA via Kaikki). Commercial monolingual
dictionaries (大辞泉, 明鏡, 新明解, 三省堂) circulate as Yomitan packs but are
not freely licensed, so they are not fetched here.

Release URLs are resolved at run time rather than pinned, so this keeps working
as upstream publishes new builds.
"""

import json
import sys
import urllib.request
import zipfile

from paths import DICTS as DEST

UA = {"User-Agent": "yomi-overlay-setup"}

# Roughly TheMoeWay's recommended Yomitan stack, restricted to sources that
# are actually freely licensed. Jitendex supersedes raw JMdict (same EDRDG
# data, better formatting/examples/cross-refs), so JMdict is not fetched.
GITHUB_RELEASES = [
    (
        "stephenmk/stephenmk.github.io",
        {"jitendex-yomitan.zip": "Jitendex — main JA→EN (TMW's pick over JMdict)"},
    ),
    (
        "yomidevs/jmdict-yomitan",
        {
            "JMnedict.zip": "JMnedict — proper names",
            "KANJIDIC_english.zip": "KANJIDIC — per-kanji readings/meanings",
        },
    ),
]

_KUU = "https://github.com/Kuuuube/yomitan-dictionaries/raw/main/dictionaries"
DIRECT = {
    # Wiktionary-derived monolingual JA→JA, published to R2 by kaikki-to-yomitan.
    "kty-ja-ja.zip": (
        "https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-ja-ja.zip",
        "Wiktionary JA→JA — monolingual",
    ),
    "JPDB_v2.2_Frequency_Kana_2024-10-13.zip": (
        f"{_KUU}/JPDB_v2.2_Frequency_Kana_2024-10-13.zip",
        "JPDB frequency — sense ordering",
    ),
    "BCCWJ_SUW_LUW_combined.zip": (
        f"{_KUU}/BCCWJ_SUW_LUW_combined.zip",
        "BCCWJ frequency — corpus-based cross-check",
    ),
}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60)


def resolve_github(repo, wanted):
    api = f"https://api.github.com/repos/{repo}/releases/latest"
    with get(api) as r:
        data = json.load(r)
    assets = {a["name"]: a["browser_download_url"] for a in data.get("assets", [])}
    missing = [n for n in wanted if n not in assets]
    if missing:
        print(f"  ! not in release {data.get('tag_name')}: {', '.join(missing)}")
    return data.get("tag_name"), {n: assets[n] for n in wanted if n in assets}


def download(name, url, label):
    out = DEST / name
    if out.exists() and zipfile.is_zipfile(out):
        print(f"  ✓ {name:<26} already present ({out.stat().st_size/1048576:.1f} MB)")
        return True

    print(f"  ↓ {name:<26} {label}")
    tmp = out.with_suffix(".part")
    try:
        with get(url) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length", 0))
            done = 0
            while chunk := r.read(1 << 16):
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    print(f"\r    {pct:3d}%  {done/1048576:.1f}/{total/1048576:.1f} MB",
                          end="", flush=True)
            print()
    except Exception as e:
        print(f"\n    failed: {e}")
        tmp.unlink(missing_ok=True)
        return False

    # A Yomitan dictionary is a zip containing index.json — verify before keeping.
    if not zipfile.is_zipfile(tmp):
        print("    failed: not a zip")
        tmp.unlink(missing_ok=True)
        return False
    with zipfile.ZipFile(tmp) as z:
        if "index.json" not in z.namelist():
            print("    failed: no index.json (not a Yomitan dictionary)")
            tmp.unlink(missing_ok=True)
            return False
        meta = json.loads(z.read("index.json"))
    tmp.replace(out)
    print(f"    ok — title={meta.get('title')!r} rev={meta.get('revision')}")
    return True


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    print(f"destination: {DEST}\n")

    ok = failed = 0

    for repo, wanted in GITHUB_RELEASES:
        print(f"github:{repo}")
        try:
            tag, urls = resolve_github(repo, wanted)
            print(f"  release {tag}")
            for name, url in urls.items():
                if download(name, url, wanted[name]):
                    ok += 1
                else:
                    failed += 1
        except Exception as e:
            print(f"  ! could not reach github: {e}")
            failed += len(wanted)

    print("\ndirect:")
    for name, (url, label) in DIRECT.items():
        if download(name, url, label):
            ok += 1
        else:
            failed += 1

    print(f"\n{ok} ready, {failed} failed")
    have = sorted(DEST.glob("*.zip"))
    if have:
        total = sum(p.stat().st_size for p in have) / 1048576
        print(f"{len(have)} dictionaries, {total:.0f} MB total")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
