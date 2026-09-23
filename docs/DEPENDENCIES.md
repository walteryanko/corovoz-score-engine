# Dependency license inventory

Inspected installed package metadata and license-file presence on 2026-09-23. The lockfile pins the tree. Dependencies are fetched by npm, not vendored or included in the deliverable. This is not a legal opinion or an exhaustive origin audit of every package file.

Direct dependencies: JSZip 3.10.1 (MIT OR GPL-3.0-or-later; the MIT option is applicable to this dependency), fast-xml-parser 5.11.1 (MIT), linkedom 0.18.12 (ISC). The selected first-party CoroVoz engine is separately licensed MPL-2.0; these upstream packages retain their own licenses. Preserve upstream notices when later distributing a bundled application. Pako declares MIT AND Zlib, so both notice obligations matter.

| Package | Version | Declared license | License material present |
| --- | --- | --- | --- |
| @nodable/entities | 3.0.0 | MIT | No separate file found; metadata only |
| anynum | 1.0.1 | MIT | LICENSE |
| boolbase | 1.0.0 | ISC | No separate file found; metadata only |
| core-util-is | 1.0.3 | MIT | LICENSE |
| css-select | 5.2.2 | BSD-2-Clause | LICENSE |
| css-what | 6.2.2 | BSD-2-Clause | LICENSE |
| cssom | 0.5.0 | MIT | LICENSE.txt |
| dom-serializer | 2.0.0 | MIT | LICENSE |
| domelementtype | 2.3.0 | BSD-2-Clause | LICENSE |
| domhandler | 5.0.3 | BSD-2-Clause | LICENSE |
| domutils | 3.2.2 | BSD-2-Clause | LICENSE |
| entities | 4.5.0 | BSD-2-Clause | LICENSE |
| entities | 7.0.1 | BSD-2-Clause | LICENSE |
| fast-xml-builder | 1.3.1 | MIT | LICENSE |
| fast-xml-parser | 5.11.1 | MIT | LICENSE |
| html-escaper | 3.0.3 | MIT | LICENSE.txt |
| htmlparser2 | 10.1.0 | MIT | LICENSE |
| immediate | 3.0.6 | MIT | LICENSE.txt |
| inherits | 2.0.4 | ISC | LICENSE |
| is-unsafe | 2.0.2 | MIT | LICENSE |
| isarray | 1.0.0 | MIT | No separate file found; metadata only |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | LICENSE.markdown |
| lie | 3.3.0 | MIT | license.md |
| linkedom | 0.18.12 | ISC | LICENSE |
| nth-check | 2.1.1 | BSD-2-Clause | LICENSE |
| pako | 1.0.11 | (MIT AND Zlib) | LICENSE |
| path-expression-matcher | 1.6.2 | MIT | LICENSE |
| process-nextick-args | 2.0.1 | MIT | license.md |
| readable-stream | 2.3.8 | MIT | LICENSE |
| safe-buffer | 5.1.2 | MIT | LICENSE |
| setimmediate | 1.0.5 | MIT | LICENSE.txt |
| string_decoder | 1.1.1 | MIT | LICENSE |
| strnum | 2.4.2 | MIT | LICENSE |
| uhyphen | 0.2.0 | ISC | LICENSE |
| util-deprecate | 1.0.2 | MIT | LICENSE |
| xml-naming | 0.3.0 | MIT | LICENSE |

`npm audit --json` on this installed tree reported zero known advisories on 2026-09-23. This is time-bound registry evidence, not proof of safety. A fresh install/CI must be repeated before release. Packages lacking a separate license file remain a notice-verification follow-up before binary bundling. No binary bundle is being released.
