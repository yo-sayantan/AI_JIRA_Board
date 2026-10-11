#!/usr/bin/env python3
"""The help/ guide: plain pages that must work straight from disk. Every link lands somewhere real, every page
carries the same navigation, and the bundled data copy (help-data.js) matches its sources."""
import os
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELP = ROOT / "help"

# The guide's numbered pages, in reading order — the file names ARE the table of contents.
NUMBERED = sorted(p.name for p in HELP.glob("[0-9][0-9]-*.html"))
EXTRA = ["developer-doc-viewer.html", "legal-privacy-and-accessibility.html"]
DATA_PAGES = {"06-ai-local-models.html", "07-ai-cloud-models-and-prices.html", "developer-doc-viewer.html"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.links, self.scripts, self.styles = set(), [], [], []
        self.nav, self.toc_pages, self.pager = [], [], {}
        self._in = []  # open elements of interest

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.add(a["id"])
        cls = a.get("class") or ""
        if tag == "nav" and "top" in cls.split():
            self._in.append("topnav")
        elif tag == "nav" and "pager" in cls.split():
            self._in.append("pager")
        elif tag == "aside":
            self._in.append("toc")
        elif tag in ("nav", "aside"):
            self._in.append("other")
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
            where = self._in[-1] if self._in else None
            if where == "topnav" and "nl" in cls.split():
                self.nav.append((a["href"], a.get("aria-current")))
            elif where == "toc" and not a["href"].startswith("#"):
                self.toc_pages.append((a["href"], a.get("aria-current")))
            elif where == "pager":
                self.pager["prev" if "prev" in cls.split() else "next"] = a["href"]
        if tag == "script" and a.get("src"):
            self.scripts.append(a["src"])
        if tag == "link" and a.get("rel") == "stylesheet":
            self.styles.append(a.get("href"))

    def handle_endtag(self, tag):
        if tag in ("nav", "aside") and self._in:
            self._in.pop()


def parse(name):
    p = Page()
    p.feed((HELP / name).read_text(encoding="utf-8"))
    return p


ALL = NUMBERED + EXTRA
PARSED = {name: parse(name) for name in ALL}


class Files(unittest.TestCase):
    def test_the_numbered_pages_run_00_to_11_without_a_gap(self):
        self.assertEqual([n[:2] for n in NUMBERED], [f"{i:02d}" for i in range(12)])
        self.assertEqual(NUMBERED[0], "00-start-here.html")

    def test_names_are_plain_lowercase_words(self):
        for name in ALL:
            self.assertRegex(name, r"^([0-9]{2}-)?[a-z]+(-[a-z]+)*\.html$", name)

    def test_the_old_guide_files_are_gone(self):
        for old in ("index.html", "doc.html", "legal.html", "anchors.js"):
            self.assertFalse((ROOT / "docs" / old).exists(), f"docs/{old} moved to help/")

    def test_every_page_uses_the_one_stylesheet_and_script(self):
        for name, p in PARSED.items():
            self.assertEqual(p.styles, ["help.css"], name)
            self.assertEqual(p.scripts[-1], "help.js", name)
            if name in DATA_PAGES:
                self.assertEqual(p.scripts, ["help-data.js", "help.js"], name)

    def test_nothing_is_loaded_from_the_internet(self):
        for name, p in PARSED.items():
            for src in p.scripts + p.styles:
                self.assertNotRegex(src, r"^(https?:)?//", f"{name} loads {src}")


class Links(unittest.TestCase):
    def check(self, name, href):
        if re.match(r"^(https?:|mailto:|data:)", href):
            return
        path, _, frag = href.partition("#")
        path = path.split("?")[0]
        if not path:  # in-page
            self.assertIn(frag, PARSED[name].ids, f"{name}: #{frag} has no target")
            return
        target = (HELP / path).resolve()
        self.assertTrue(target.exists(), f"{name}: {href} → missing {target.relative_to(ROOT) if ROOT in target.parents else target}")
        if frag and target.parent == HELP and target.name in PARSED and target.name != "developer-doc-viewer.html":
            self.assertIn(frag, PARSED[target.name].ids, f"{name}: {href} — no #{frag} on that page")

    def test_every_link_on_every_page_lands_somewhere_real(self):
        for name, p in PARSED.items():
            for href in p.links:
                self.check(name, href)

    def test_the_start_page_lists_every_numbered_page(self):
        hrefs = PARSED["00-start-here.html"].links
        for name in NUMBERED[1:]:
            self.assertIn(name, hrefs)


class Navigation(unittest.TestCase):
    def test_every_page_has_the_same_top_nav_in_reading_order(self):
        for name, p in PARSED.items():
            self.assertEqual([h for h, _ in p.nav], NUMBERED, name)
            current = [h for h, c in p.nav if c == "page"]
            self.assertEqual(current, [name] if name in NUMBERED else [], name)

    def test_every_sidebar_lists_every_page_and_marks_its_own(self):
        for name, p in PARSED.items():
            self.assertEqual([h for h, _ in p.toc_pages], NUMBERED + ["legal-privacy-and-accessibility.html"], name)
            self.assertEqual([h for h, c in p.toc_pages if c == "page"], [name] if name in NUMBERED or name.startswith("legal") else [], name)

    def test_previous_and_next_follow_the_numbers(self):
        for i, name in enumerate(NUMBERED):
            pager = PARSED[name].pager
            self.assertEqual(pager.get("prev"), NUMBERED[i - 1] if i else None, name)
            self.assertEqual(pager.get("next"), NUMBERED[i + 1] if i + 1 < len(NUMBERED) else None, name)


class Data(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_the_bundled_copy_matches_its_sources(self):
        r = subprocess.run(["node", str(ROOT / "scripts" / "build-help-data.mjs"), "--check"], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stderr or r.stdout)

    def test_the_doc_viewer_knows_every_doc_and_only_real_ones(self):
        js = (HELP / "help.js").read_text(encoding="utf-8")
        listed = re.findall(r"\['([A-Z-]+\.md)',", js)
        on_disk = sorted(p.name for p in (ROOT / "docs").glob("*.md"))
        self.assertEqual(sorted(listed), on_disk)

    def test_the_app_points_at_pages_that_exist(self):
        ts = (ROOT / "src" / "lib" / "runner.ts").read_text(encoding="utf-8")
        pages = re.findall(r"'([0-9]{2}-[a-z-]+\.html)(?:#([\w-]+))?'", ts)
        self.assertGreaterEqual(len(pages), 3)
        for page, frag in pages:
            self.assertIn(page, PARSED, page)
            if frag:
                self.assertIn(frag, PARSED[page].ids, f"{page}#{frag}")


if __name__ == "__main__":
    unittest.main()
