# Browser preview credits

This package runs the original **Ford Racing 3 Windows demo**, copyright
2004 Empire Interactive Europe Ltd. The game executable, DLLs, data and
original `README/` files are preserved. It is not a reconstruction of the
engine. Game copyright and licensing are unchanged.

The emulator is [Boxedwine](https://github.com/danoon2/Boxedwine), pinned to
commit `65467424603484756a73308412f40b906d28b650`, licensed under GPL version 2
or later. [License](licenses/Boxedwine-GPL-2.0.txt) ·
[Corresponding emulator source and build files](licenses/boxedwine-source.tar.gz).
Build it with Emscripten 5.0.7 using this repository's `scripts/build_web.py`.
The source archive includes notices for its bundled SDL, zlib, softfloat,
SIMDe and other dependencies.

The Wine 11 filesystem is the checksum-verified
Boxedwine web filesystem 14 (originally `https://boxedwine.org/v2/14/TinyCore15Wine11.0-web.zip`,
now [mirrored unmodified](https://github.com/omertekin2002/ford-racing-reverse-engineered/releases/tag/wine-web-fs-v14)),
with WineD3D WebGL patches. Its exact Wine source revision, production patches,
dependency pins and build commands are included in the emulator source archive
under `tools/buildWine/` and `tools/d3dToWebGL/`.
Wine is licensed under LGPL 2.1 or later. Wine sources and notices are available
[with its license](licenses/Wine-LGPL-2.1.txt),
from [Wine](https://gitlab.winehq.org/wine/wine/-/tree/wine-11.0) and the
[Boxedwine Wine-build scripts](https://github.com/danoon2/Boxedwine/tree/65467424603484756a73308412f40b906d28b650/tools/buildWine).
The filesystem preserves upstream files; additional source references and
licenses are linked from the release and build scripts. Game input and profile
data remain on the user's device; this static site uses no backend or analytics.
