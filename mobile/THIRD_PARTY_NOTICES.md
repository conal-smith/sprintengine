# Third-party notices

The app is MIT licensed as part of this repository (see `LICENSE` at the
repository root). It includes or bundles the third-party software below, whose
notices are reproduced here as their licences require. Every other runtime
dependency is installed from npm under its own licence, which ships in its
package in `node_modules/`.

## Bundled into the diagram and maths renderer

`src/components/document/rich/richRendererDocument.generated.ts` is built by
`scripts/build-rich-renderer.mjs` from the minified distributions of Mermaid
and KaTeX (including KaTeX's fonts). The Mermaid bundle keeps, inline, the
licence notices of the libraries it bundles in turn (among them DOMPurify,
under Apache-2.0 or MPL-2.0; js-yaml, lodash-es and Cytoscape.js, under MIT).

### KaTeX 0.16.47

```
The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

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

### Mermaid 11.13.0

```
The MIT License (MIT)

Copyright (c) 2014 - 2022 Knut Sveidqvist

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

## Dependencies with unusual licences

### react-native-fit-image (Beerware)

Pulled in by `react-native-markdown-display` and bundled into the app's
JavaScript.

```
"THE BEER-WARE LICENSE" (Revision 42):
<originerd@gmail.com> wrote this file. As long as you retain this notice you
can do whatever you want with this stuff. If we meet some day, and you think
this stuff is worth it, you can buy me a beer in return.           Jitae Kim
```

### Build tooling only (not shipped in the app)

- **node-forge** — dual licensed BSD-3-Clause or GPL-2.0; used here under
  BSD-3-Clause. Reached through Expo's CLI and code-signing tooling.
- **lightningcss** — MPL-2.0. Reached through Expo's Metro config.
- **caniuse-lite** — CC-BY-4.0 (data). Reached through the Babel toolchain.
