"""Synthetic tests for demo acquisition; nothing here downloads or reads the real demo."""
import hashlib
import io
from pathlib import Path
import re
import struct
import sys
import tempfile
import unittest
from unittest import mock
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import acquire_demo
from acquire_demo import DEMO_PAGE, acquire, download_links, extract_zip, fetch
from setup_tools import HTTPSRedirect

START = "https://www.moddb.com/downloads/start/123"
MIRROR = "https://www.moddb.com/downloads/mirror/123/456"
FINAL = "https://mirror.example/files/fordracing3demo.zip"
PAYLOAD = b"synthetic Ford Racing 3 demo archive"


def network_reached(*args, **kwargs):
    raise AssertionError("A synthetic acquisition test reached the network")


def setUpModule():
    for target in ("urllib.request.urlopen", "urllib.request.OpenerDirector.open"):
        patcher = mock.patch(target, network_reached)
        patcher.start()
        unittest.addModuleCleanup(patcher.stop)


def anchors(*hrefs):
    return "".join(f'<a href="{href}">link</a>' for href in hrefs).encode()


def patch_identity(test, payload):
    for name, value in (("ARCHIVE_SIZE", len(payload)), ("ARCHIVE_SHA256", hashlib.sha256(payload).hexdigest())):
        patcher = mock.patch.object(acquire_demo, name, value)
        patcher.start()
        test.addCleanup(patcher.stop)


class NetworkGuardTests(unittest.TestCase):
    def test_https_fetch_hits_the_guard(self):
        with self.assertRaisesRegex(AssertionError, "reached the network"):
            fetch(DEMO_PAGE)


class DownloadLinksTests(unittest.TestCase):
    def test_resolve_relative_and_absolute_hrefs_against_final_url(self):
        page = '<a href="../mirror/123/456">mirror</a><a href="/downloads/start/9">start</a>'
        page += f'<a href="{MIRROR}">absolute</a><a href="//www.moddb.com/downloads/start/7">scheme-relative</a>'
        self.assertEqual(list(download_links(page, START)), [
            MIRROR,
            "https://www.moddb.com/downloads/start/9",
            MIRROR,
            "https://www.moddb.com/downloads/start/7",
        ])

    def test_reject_plain_http_and_other_hosts(self):
        page = anchors(
            "http://www.moddb.com/downloads/start/1",
            "https://moddb.com/downloads/start/1",
            "https://www.moddb.com.example.net/downloads/start/1",
            "https://cdn.www.moddb.com/downloads/start/1",
            "https://www.moddb.com@evil.example/downloads/start/1",
            "https://evil.example/downloads/mirror/1/2",
            "ftp://www.moddb.com/downloads/start/1",
        ).decode()
        self.assertEqual(list(download_links(page, DEMO_PAGE)), [])

    def test_reject_relative_href_on_plain_http_page(self):
        self.assertEqual(list(download_links('<a href="/downloads/start/1">x</a>', "http://www.moddb.com/games/x")), [])

    def test_reject_paths_outside_download_prefixes(self):
        page = anchors(
            "/downloads/startx/1",
            "/downloads/start",
            "/downloads/",
            "/downloads/mirrors/1",
            "/games/ford-racing/downloads/start/1",
            "/members/downloads/mirror/1/2",
            "ford-racing-3-demo",
        ).decode()
        self.assertEqual(list(download_links(page, DEMO_PAGE)), [])

    def test_ignore_anchors_without_href_and_other_tags(self):
        page = '<a>none</a><a href="">empty</a><a name="/downloads/start/1">named</a>'
        page += '<link href="/downloads/start/2"><img src="/downloads/start/3">'
        self.assertEqual(list(download_links(page, DEMO_PAGE)), [])


class FetchTests(unittest.TestCase):
    def test_reject_non_https_before_network(self):
        for url in ("http://www.moddb.com/downloads/start/1", "ftp://www.moddb.com/x", "file:///etc/passwd"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "Acquisition requires HTTPS"):
                fetch(url)


class HTTPSRedirectTests(unittest.TestCase):
    def setUp(self):
        self.request = urllib.request.Request(START)

    def test_refuse_redirect_to_plain_http(self):
        with self.assertRaisesRegex(ValueError, "Refusing non-HTTPS tool download redirect"):
            HTTPSRedirect().redirect_request(self.request, None, 302, "Found", {}, "http://mirror.example/demo.zip")

    def test_allow_redirect_to_https(self):
        redirected = HTTPSRedirect().redirect_request(self.request, None, 302, "Found", {}, FINAL)
        self.assertEqual(redirected.full_url, FINAL)


class AcquireTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.destination = self.root / "inputs" / "fordracing3demo.zip"
        patch_identity(self, PAYLOAD)
        self.pages = {}
        self.fetched = []
        patcher = mock.patch.object(acquire_demo, "fetch", self.fake_fetch)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_fetch(self, url):
        self.fetched.append(url)
        response = self.pages.get(url)
        if response is None:
            raise AssertionError(f"Unexpected fetch: {url}")
        if isinstance(response, Exception):
            raise response
        return response

    def test_follow_start_and_mirror_links_to_archive(self):
        self.pages = {
            DEMO_PAGE: (anchors("/downloads/start/123"), DEMO_PAGE),
            START: (anchors("/downloads/mirror/123/456"), START),
            MIRROR: (PAYLOAD, FINAL),
        }
        result = acquire(self.destination)
        self.assertEqual(result, {"mode": "download", "source_page": DEMO_PAGE, "download_url": FINAL})
        self.assertEqual(self.fetched, [DEMO_PAGE, START, MIRROR])
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_start_from_explicit_url(self):
        self.pages = {MIRROR: (PAYLOAD, FINAL)}
        self.assertEqual(acquire(self.destination, MIRROR)["download_url"], FINAL)
        self.assertEqual(self.fetched, [MIRROR])

    def test_resolve_links_against_redirected_url(self):
        self.pages = {
            DEMO_PAGE: (anchors("start/123"), "https://www.moddb.com/downloads/"),
            START: (PAYLOAD, FINAL),
        }
        self.assertEqual(acquire(self.destination)["mode"], "download")
        self.assertEqual(self.fetched, [DEMO_PAGE, START])

    def test_skip_seen_urls(self):
        self.pages = {
            DEMO_PAGE: (anchors("/downloads/start/123", "/downloads/start/123"), DEMO_PAGE),
            START: (anchors("/downloads/start/123", "/downloads/mirror/123/456"), START),
            MIRROR: (PAYLOAD, FINAL),
        }
        acquire(self.destination)
        self.assertEqual(self.fetched, [DEMO_PAGE, START, MIRROR])

    def test_keep_links_before_a_malformed_href(self):
        self.pages = {
            DEMO_PAGE: (anchors("/downloads/start/123", "https://[malformed/downloads/start/1"), DEMO_PAGE),
            START: (PAYLOAD, FINAL),
        }
        self.assertEqual(acquire(self.destination)["download_url"], FINAL)
        self.assertEqual(self.fetched, [DEMO_PAGE, START])

    def test_stop_after_twelve_distinct_urls(self):
        starts = [f"https://www.moddb.com/downloads/start/{n}" for n in range(20)]
        self.pages = {DEMO_PAGE: (anchors(*starts), DEMO_PAGE)}
        self.pages.update({url: (b"<p>no links</p>", url) for url in starts})
        self.pages[starts[-1]] = (PAYLOAD, FINAL)
        with self.assertRaisesRegex(RuntimeError, "Demo acquisition failed"):
            acquire(self.destination)
        self.assertEqual(self.fetched, [DEMO_PAGE, *starts[:11]])
        self.assertFalse(self.destination.exists())

    def test_report_every_per_url_error(self):
        other = "https://www.moddb.com/downloads/start/124"
        self.pages = {
            DEMO_PAGE: (anchors(START, other, "/downloads/mirror/1/1"), DEMO_PAGE),
            START: OSError("connection reset"),
            other: ValueError("Refusing a redirect away from HTTPS"),
            "https://www.moddb.com/downloads/mirror/1/1": (b"<p>no links</p>", FINAL),
        }
        with self.assertRaises(RuntimeError) as caught:
            acquire(self.destination)
        self.assertEqual(str(caught.exception), "\n".join([
            "Demo acquisition failed:",
            f"{START}: connection reset",
            f"{other}: Refusing a redirect away from HTTPS",
            "https://www.moddb.com/downloads/mirror/1/1: no matching demo archive or download links",
        ]))

    def test_reject_page_without_links(self):
        self.pages = {DEMO_PAGE: (b"<p>Demo removed</p>", DEMO_PAGE)}
        with self.assertRaisesRegex(RuntimeError, "ford-racing-3-demo: no matching demo archive or download links"):
            acquire(self.destination)

    def test_write_nothing_for_wrong_hash_of_right_size(self):
        wrong = bytes(reversed(PAYLOAD))
        self.assertEqual(len(wrong), len(PAYLOAD))
        self.pages = {DEMO_PAGE: (anchors(START), DEMO_PAGE), START: (wrong, FINAL)}
        with self.assertRaisesRegex(RuntimeError, "no matching demo archive or download links"):
            acquire(self.destination)
        self.assertFalse(self.destination.parent.exists())

    def test_verify_existing_archive_without_downloading(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(PAYLOAD)
        self.assertEqual(acquire(self.destination), {"mode": "verified_local_archive", "source_page": DEMO_PAGE})
        self.assertEqual(self.fetched, [])

    def test_reject_corrupt_existing_archive(self):
        self.destination.parent.mkdir()
        corrupt = PAYLOAD[:-1] + b"?"
        self.destination.write_bytes(corrupt)
        with self.assertRaisesRegex(ValueError, "Identity mismatch"):
            acquire(self.destination)
        self.assertEqual(self.fetched, [])
        self.assertEqual(self.destination.read_bytes(), corrupt)


def zip_bytes(*members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zipped:
        for member, data in members:
            zipped.writestr(member, data)
    return buffer.getvalue()


def declare_sizes(data, size):
    """Rewrite every central-directory uncompressed size without storing that much data."""
    data = bytearray(data)
    offset = data.find(b"PK\x01\x02")
    while offset != -1:
        struct.pack_into("<I", data, offset + 24, size)
        offset = data.find(b"PK\x01\x02", offset + 4)
    return bytes(data)


class ExtractZipTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.archive = self.root / "fordracing3demo.zip"
        self.destination = self.root / "installer"

    def write_archive(self, data):
        self.archive.write_bytes(data)
        patch_identity(self, data)

    def assert_rejected(self, data, message):
        self.write_archive(data)
        with self.assertRaisesRegex(ValueError, message):
            extract_zip(self.archive, self.destination)
        self.assertFalse(self.destination.exists())

    def test_extract_tree_with_backslash_names(self):
        self.write_archive(zip_bytes(
            ("Setup/", b""),
            ("Setup/data1.cab", b"cab"),
            ("Setup\\Disk1\\setup.exe", b"exe"),
            ("readme.txt", b"text"),
        ))
        extract_zip(self.archive, self.destination)
        self.assertEqual((self.destination / "Setup/data1.cab").read_bytes(), b"cab")
        self.assertEqual((self.destination / "Setup/Disk1/setup.exe").read_bytes(), b"exe")
        self.assertEqual((self.destination / "readme.txt").read_bytes(), b"text")
        self.assertEqual(sorted(p.relative_to(self.destination).as_posix() for p in self.destination.rglob("*")), [
            "Setup", "Setup/Disk1", "Setup/Disk1/setup.exe", "Setup/data1.cab", "readme.txt",
        ])

    def test_reject_identity_mismatch(self):
        self.archive.write_bytes(zip_bytes(("readme.txt", b"text")))
        patch_identity(self, zip_bytes(("readme.txt", b"other")))
        with self.assertRaisesRegex(ValueError, "Identity mismatch"):
            extract_zip(self.archive, self.destination)
        self.assertFalse(self.destination.exists())

    def test_reject_unsafe_paths(self):
        for index, name in enumerate(("/abs/file", "../escape", "Setup/../../escape", "C:/Windows/file", "C:file", "..\\escape", "Setup\\..\\..\\escape", "\\abs\\file")):
            with self.subTest(name=name):
                self.destination = self.root / f"installer-{index}"
                self.assert_rejected(zip_bytes(("readme.txt", b"text"), (name, b"x")), "Unsafe ZIP path: " + re.escape(name))

    def test_reject_symlink_members(self):
        link = zipfile.ZipInfo("Setup/link")
        link.external_attr = 0o120777 << 16
        self.assert_rejected(zip_bytes(("readme.txt", b"text"), (link, b"/etc/passwd")), "ZIP symlinks are not supported")

    def test_reject_declared_total_over_limit(self):
        # Each member is under the limit; together they exceed it.
        data = declare_sizes(zip_bytes(("a.bin", b"a"), ("b.bin", b"b")), 100_000_001)
        self.write_archive(data)
        self.assertEqual([m.file_size for m in zipfile.ZipFile(self.archive).infolist()], [100_000_001, 100_000_001])
        with self.assertRaisesRegex(ValueError, "Installer ZIP exceeds extraction limit"):
            extract_zip(self.archive, self.destination)
        self.assertFalse(self.destination.exists())

    def test_rerun_over_identical_extraction(self):
        self.write_archive(zip_bytes(("Setup/data1.cab", b"cab"), ("readme.txt", b"text")))
        extract_zip(self.archive, self.destination)
        extract_zip(self.archive, self.destination)
        self.assertEqual((self.destination / "Setup/data1.cab").read_bytes(), b"cab")

    def test_reject_differing_existing_file(self):
        self.write_archive(zip_bytes(("Setup/data1.cab", b"cab")))
        existing = self.destination / "Setup/data1.cab"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"owner's file")
        with self.assertRaisesRegex(ValueError, "Existing installer file differs"):
            extract_zip(self.archive, self.destination)
        self.assertEqual(existing.read_bytes(), b"owner's file")


if __name__ == "__main__":
    unittest.main()
