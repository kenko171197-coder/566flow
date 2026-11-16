#!/usr/bin/env python3
"""Build config/i18n.json for 566Flow (no translation server).

Sources, in priority order:
  1. existing config/i18n.json values (HTML data-i18n defaults, hand edits)
  2. fallbacks written next to the key in JS:
       I18n.t("k") || "Text"      window.I18n?.t?.("k") || "Text"
       t("k", "Text")             _t("k", "Text")
  3. a humanized version of the key ("tasks.addFirstTask" -> "Add first task")
Run from the repo root:  python3 tools/gen_i18n.py
"""
import glob
import json
import re

OUT = "config/i18n.json"
KEY = r"[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+"
STR = r"""(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)"""

P_OR = re.compile(
    r"""\bt\??\.?\(\s*["'](""" + KEY + r""")["']\s*(?:,\s*\{[^()]*?\})?\s*\)\s*\|\|\s*""" + STR
)
P_ARG = re.compile(r"""\b_?t\(\s*["'](""" + KEY + r""")["']\s*,\s*""" + STR)
P_ANY = re.compile(r"""(?:I18n|\b_?t)\??\.?(?:t\??\.?)?\(\s*["'](""" + KEY + r""")["']""")
P_HTML = re.compile(r"""data-i18n(?:-[a-z]+)?=["'](""" + KEY + r""")["']""")


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        else:
            out[key] = v
    return out


def unescape(s):
    try:
        return json.loads('"' + s.replace('"', '\\"').replace("\\'", "'") + '"')
    except Exception:
        return s


def humanize(key):
    last = key.split(".")[-1]
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", last).replace("_", " ").strip()
    return words[:1].upper() + words[1:].lower() if words else key


def main():
    try:
        existing = flatten(json.load(open(OUT, encoding="utf-8")))
    except FileNotFoundError:
        existing = {}
    found, used = {}, set()
    files = glob.glob("src/**/*.js", recursive=True) + glob.glob("*.js") + glob.glob("*.html")
    for f in files:
        text = open(f, encoding="utf-8", errors="ignore").read()
        for m in P_OR.finditer(text):
            val = next(g for g in m.groups()[1:] if g is not None)
            if val.strip():
                found.setdefault(m.group(1), unescape(val))
        for m in P_ARG.finditer(text):
            val = next(g for g in m.groups()[1:] if g is not None)
            if val.strip():
                found.setdefault(m.group(1), unescape(val))
        used.update(m.group(1) for m in P_ANY.finditer(text))
        used.update(m.group(1) for m in P_HTML.finditer(text))

    flat = {}
    for key in sorted(used | set(found) | set(existing)):
        flat[key] = existing.get(key) or found.get(key) or humanize(key)

    # Build nested dict; a key that is both a leaf and a prefix keeps the branch.
    nested = {}
    for key in sorted(flat, key=lambda k: k.count(".")):
        parts = key.split(".")
        cur, ok = nested, True
        for p in parts[:-1]:
            if not isinstance(cur.get(p, {}), dict):
                ok = False
                break
            cur = cur.setdefault(p, {})
        if ok and not isinstance(cur.get(parts[-1]), dict):
            cur[parts[-1]] = flat[key]
    json.dump(nested, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
    print(f"{len(flat)} keys ({len(existing)} existing, {len(found)} JS fallbacks)")


if __name__ == "__main__":
    main()
