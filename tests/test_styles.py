#!/usr/bin/env python3
"""styles/glass.css: Settings → "Motion & animations" owns every decorative effect. These rules are what makes "off" a
calm, flat, still board; losing one quietly brings an effect back with the switch off. (A Python test because the
TypeScript build has no Node types, so a vitest test cannot read a stylesheet from disk.)"""
import os
import re
import unittest

CSS = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "styles", "glass.css"), encoding="utf-8").read()


class MotionSwitchOff(unittest.TestCase):
    def test_drops_the_glass(self):
        block = CSS[CSS.index("html.jb-no-anim {"):CSS.index("html.dark.jb-no-anim {")]
        for token in ("--surface-solid: #ffffff", "--glass-sheen: none", "--glass-grain: none", "--glass-reflect: none", "--rim: none"):
            self.assertIn(token, block)
        self.assertRegex(CSS, r"html\.dark\.jb-no-anim \{[^}]*--surface-solid: #")
        self.assertRegex(CSS, r"html\.jb-no-anim \*,[\s\S]*?backdrop-filter: none !important")
        self.assertRegex(CSS, r"html\.jb-no-anim body \{\s*background: var\(--bg\)")

    def test_stops_hover_and_tap_lifts(self):
        # framer-motion writes them as an inline transform and, with animations skipped, would still snap to them.
        self.assertIn("html.jb-no-anim :is(button, a, [role='button'])[style*='transform'] {\n  transform: none !important;", CSS)
        self.assertRegex(CSS, r"html\.jb-no-anim \.glass-interactive::after \{\s*display: none")

    def test_every_decorative_token_is_switched_off(self):
        # A new --glass-* token must be set to none in the off block too.
        tokens = set(re.findall(r"(--glass-(?!blur|sat)[a-z-]+):", CSS[:CSS.index(".dark {")]))
        block = CSS[CSS.index("html.jb-no-anim {"):CSS.index("html.dark.jb-no-anim {")]
        self.assertTrue(tokens)
        for t in tokens:
            self.assertIn(f"{t}: none", block, t)

    def test_matte_finish_stays_out_of_the_readable_fallbacks(self):
        reduced = CSS[CSS.index("@media (prefers-reduced-transparency"):CSS.index("@supports not")]
        self.assertIn("--glass-grain: none", reduced)
        self.assertIn("--glass-reflect: none", reduced)


if __name__ == "__main__":
    unittest.main()
