"""Synthetic tests for the browser preview's rights-holder notice check."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from fr3_common import DEMO_PAGE
from verify_web import ISSUES_PAGE, RIGHTS_CREDIT, verify_notice

NOTICE = f"""<aside id="rights-notice" aria-label="Rights notice"><p>Unofficial preview.
  {RIGHTS_CREDIT}</p><p><a href="{DEMO_PAGE}" rel="noopener">Official demo</a>
  <a href="{ISSUES_PAGE}" rel="noopener">Request removal</a></p></aside>"""
PLAYER = '<section class="player" aria-label="Game player"><div id="screen"></div></section>'


def page(*parts):
    return "<!doctype html><html><body><main>" + "".join(parts) + "</main></body></html>"


class VerifyNoticeTests(unittest.TestCase):
    def test_accept_notice_above_player(self):
        verify_notice(page('<section class="intro">', NOTICE, "</section>", PLAYER))

    def test_accept_repository_page(self):
        verify_notice((ROOT / "web/index.html").read_text(encoding="utf-8"))

    def test_reject_missing_notice(self):
        with self.assertRaisesRegex(ValueError, "lacks the rights-holder notice"):
            verify_notice(page(PLAYER))

    def test_reject_notice_below_player(self):
        with self.assertRaisesRegex(ValueError, "above the player"):
            verify_notice(page(PLAYER, NOTICE))

    def test_reject_missing_credit(self):
        with self.assertRaisesRegex(ValueError, "credit"):
            verify_notice(page(NOTICE.replace(RIGHTS_CREDIT, "Ford Racing 3 demo"), PLAYER))

    def test_reject_credit_outside_notice(self):
        notice = NOTICE.replace(RIGHTS_CREDIT, "")
        with self.assertRaisesRegex(ValueError, "credit"):
            verify_notice(page(notice, PLAYER, f"<footer>{RIGHTS_CREDIT}</footer>"))

    def test_reject_missing_links(self):
        for url in (DEMO_PAGE, ISSUES_PAGE):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "lacks a link"):
                verify_notice(page(NOTICE.replace(url, "https://example.com/"), PLAYER))

    def test_reject_link_outside_notice(self):
        notice = NOTICE.replace(DEMO_PAGE, "https://example.com/")
        with self.assertRaisesRegex(ValueError, "lacks a link"):
            verify_notice(page(notice, f'<p><a href="{DEMO_PAGE}">Demo</a></p>', PLAYER))

    def test_nested_same_tag_stays_inside_notice(self):
        notice = NOTICE.replace("<p>Unofficial", "<aside>Nested</aside><p>Unofficial")
        verify_notice(page(notice, PLAYER))


if __name__ == "__main__":
    unittest.main()
