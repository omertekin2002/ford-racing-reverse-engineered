"""Synthetic tests for the tool and download-cache root resolver."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fr3_common import download_cache, runtime_root, tools_root, web_tools_root

HOME = {"HOME": "/home/tester"}


class ToolsRootTests(unittest.TestCase):
    def test_flag_beats_env(self):
        environ = {**HOME, "FR3_TOOLS": "/env/tools", "XDG_DATA_HOME": "/xdg/data"}
        self.assertEqual(tools_root(Path("/flag/tools"), environ), Path("/flag/tools"))

    def test_env_beats_xdg(self):
        environ = {**HOME, "FR3_TOOLS": "/env/tools", "XDG_DATA_HOME": "/xdg/data"}
        self.assertEqual(tools_root(environ=environ), Path("/env/tools"))

    def test_xdg_beats_home_fallback(self):
        self.assertEqual(tools_root(environ={**HOME, "XDG_DATA_HOME": "/xdg/data"}), Path("/xdg/data/fr3-tools"))

    def test_home_fallback(self):
        self.assertEqual(tools_root(environ=HOME), Path("/home/tester/.local/share/fr3-tools"))

    def test_empty_and_relative_values_are_ignored(self):
        environ = {**HOME, "FR3_TOOLS": "", "XDG_DATA_HOME": "relative/data"}
        self.assertEqual(tools_root(environ=environ), Path("/home/tester/.local/share/fr3-tools"))
        self.assertEqual(tools_root(environ={**HOME, "FR3_TOOLS": "  ", "XDG_DATA_HOME": ""}),
                         Path("/home/tester/.local/share/fr3-tools"))


class DownloadCacheTests(unittest.TestCase):
    def test_flag_beats_env(self):
        environ = {**HOME, "FR3_CACHE": "/env/cache", "XDG_CACHE_HOME": "/xdg/cache"}
        self.assertEqual(download_cache(Path("/flag/cache"), environ), Path("/flag/cache"))

    def test_env_beats_xdg(self):
        environ = {**HOME, "FR3_CACHE": "/env/cache", "XDG_CACHE_HOME": "/xdg/cache"}
        self.assertEqual(download_cache(environ=environ), Path("/env/cache"))

    def test_xdg_beats_home_fallback(self):
        self.assertEqual(download_cache(environ={**HOME, "XDG_CACHE_HOME": "/xdg/cache"}), Path("/xdg/cache/fr3/downloads"))

    def test_home_fallback_and_empty_env(self):
        environ = {**HOME, "FR3_CACHE": "", "XDG_CACHE_HOME": ""}
        self.assertEqual(download_cache(environ=environ), Path("/home/tester/.cache/fr3/downloads"))

    def test_cache_ignores_tools_root(self):
        self.assertEqual(download_cache(environ={**HOME, "FR3_TOOLS": "/env/tools"}), Path("/home/tester/.cache/fr3/downloads"))


class DerivedRootTests(unittest.TestCase):
    def test_runtime_follows_tools_root(self):
        self.assertEqual(runtime_root(environ={**HOME, "FR3_TOOLS": "/env/tools"}), Path("/env/tools/runtime"))
        self.assertEqual(runtime_root(environ=HOME), Path("/home/tester/.local/share/fr3-tools/runtime"))
        self.assertEqual(runtime_root(Path("/flag/runtime"), {**HOME, "FR3_TOOLS": "/env/tools"}), Path("/flag/runtime"))

    def test_web_prefers_its_own_env(self):
        environ = {**HOME, "FR3_TOOLS": "/env/tools", "FR3_WEB_TOOLS": "/env/web"}
        self.assertEqual(web_tools_root(environ=environ), Path("/env/web"))
        self.assertEqual(web_tools_root(Path("/flag/web"), environ), Path("/flag/web"))

    def test_web_falls_back_to_tools_root(self):
        self.assertEqual(web_tools_root(environ={**HOME, "FR3_TOOLS": "/env/tools", "FR3_WEB_TOOLS": ""}), Path("/env/tools/web"))
        self.assertEqual(web_tools_root(environ=HOME), Path("/home/tester/.local/share/fr3-tools/web"))

    def test_legacy_workspace_layout(self):
        environ = {**HOME, "FR3_TOOLS": "/workspace/toolchains/fr3", "FR3_CACHE": "/workspace/shared/downloads"}
        self.assertEqual(runtime_root(environ=environ), Path("/workspace/toolchains/fr3/runtime"))
        self.assertEqual(web_tools_root(environ=environ), Path("/workspace/toolchains/fr3/web"))
        self.assertEqual(download_cache(environ=environ), Path("/workspace/shared/downloads"))


if __name__ == "__main__":
    unittest.main()
