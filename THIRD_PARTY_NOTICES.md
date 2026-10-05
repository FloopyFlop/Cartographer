# Third-party notices

Cartographer uses the software and resources listed below. Their original
licenses and copyrights remain in effect independently of the license for
Cartographer's own code. This file does not grant rights to remote map data,
Street View imagery, service responses, or trademarks.

## Distributed client and copied source

`npm run build` creates `dist/licenses/` from the locked, installed npm packages.
That directory contains original license/notice texts and an exact dependency
inventory in `npm-packages.json`. It is included in the Docker application and
the release archive. The inventory covers production npm dependencies and
Tailwind CSS, whose generated CSS is distributed in the client. No additional
network requests are needed to produce the notice archive after `npm ci`.

| Component | License and retained notices |
| --- | --- |
| CesiumJS 1.137.0, including its engine and widgets | Apache-2.0; the complete upstream `LICENSE.md` also includes bundled third-party code and asset notices. Copied into `dist/licenses/npm/cesium/`. |
| MapLibre GL JS 6.11.2 | BSD-3-Clause; its full `LICENSE.txt` includes notices for older Mapbox GL JS, glfx.js, and d3-color code. |
| React and React DOM | MIT; exact versions and license files are recorded in the generated archive. |
| Radix UI components | MIT; each installed package's notice is copied into the archive. |
| shadcn/ui component source | MIT, Copyright (c) 2023 shadcn. See the full license below. |
| Lucide React icons | ISC, with additional upstream icon notices in the package's license file. |
| class-variance-authority | Apache-2.0. |
| clsx, tailwind-merge, Tailwind CSS | MIT. |
| Geist font, distributed through `@fontsource/geist` | SIL Open Font License 1.1; Copyright 2024 The Geist Project Authors. The full OFL and copyright are copied from the installed package. |
| Inter font package, installed through `@fontsource/inter` | SIL Open Font License 1.1; Copyright 2016 The Inter Project Authors. Its full license is also retained; the current application imports Geist. |
| Supplied Titanium source, adapted in `src/vendor/titanium/` | MIT, Copyright (c) 2026 Titanium Contributors. The original [license](src/vendor/titanium/LICENSE) remains in the source and compiled notice archive. Cartographer adapts the viewer, imagery integration, and rendering controls. |

The generated archive preserves transitive dependency notices too. Some npm
packages place their license in a README or source header instead of a dedicated
license file; those files are retained. Cesium's aggregate license preserves
its Draco, LERC, bitmap-sdf, and other bundled dependency notices. The
`mersenne-twister` source header is also retained because it contains the
original generator's copyright and BSD conditions. The upstream notice for
`react-remove-scroll-bar`, whose npm package declares MIT without shipping a
standalone license file, is included below.

### shadcn/ui source license

Source: [shadcn/ui LICENSE.md](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### react-remove-scroll-bar upstream license

Source: [react-remove-scroll-bar LICENSE](https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE).

```text
MIT License

Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Backend dependencies

The Python environment is installed separately using `backend/uv.lock`. The
release archive contains backend source and lockfiles, not Python packages.
The Docker application retains installed packages' `.dist-info` license files.
These are the direct dependency licenses recorded in their installed metadata:

| Component | License |
| --- | --- |
| Flask | BSD-3-Clause |
| HTTPX | BSD-3-Clause |
| OpenAI Python SDK | Apache-2.0 |
| Pillow | MIT-CMU, with its upstream bundled-library notices |
| PyMongo | Apache-2.0 |
| python-dotenv | BSD-3-Clause |
| Waitress | ZPL-2.1 |

These licenses cover the SDKs and libraries. Google Maps Platform and OpenAI
API usage remains subject to those providers' separate service terms.

## Maps and external resources

The default map renders OpenFreeMap vector tiles through MapLibre and Cesium.
The dark style derives from OpenMapTiles and CARTO/CartoDB work, with code under
BSD-3-Clause and design under CC-BY-4.0. Its retained copyright identifies
MapTiler.com & OpenMapTiles contributors and CartoDB Inc. The original
[style license and attribution requirements](src/vendor/titanium/OpenFreeMap-Dark-LICENSE.md)
are also included in `dist/licenses/titanium/`. Cartographer removes references
to unavailable sprite assets when loading the remote style. OpenMapTiles and
OpenStreetMap credits remain visible in the map's attribution.

- [OpenFreeMap](https://openfreemap.org/) supplies the hosted tile/style service.
- [OpenMapTiles](https://openmaptiles.org/) identifies the tile schema and style
  attribution requirements.
- [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) supply
  map data under ODbL; this code repository does not distribute their database.
- Any enabled Esri or CARTO raster fallback uses that provider's separate map
  service/data terms and credits.
- Google Street View imagery is fetched from Google Maps Platform at runtime.
  It is not licensed by Cartographer's software license and is not included in
  source or release archives. Preserve Google and imagery-provider attribution
  and follow the applicable [Street View policies](https://developers.google.com/maps/documentation/streetview/policies)
  and [Maps Platform terms](https://cloud.google.com/maps-platform/terms).

MongoDB Community Server is installed/downloaded separately or run through the
official Docker image. The repository and release archive do not include the
server binary or database contents. MongoDB Server's
[Server Side Public License](https://www.mongodb.com/legal/licensing/server-side-public-license)
is separate from PyMongo's Apache-2.0 license and from Cartographer's own code.
Runtime base images, Node.js, Python, and uv retain their respective upstream
licenses; they are not relicensed by this repository.
