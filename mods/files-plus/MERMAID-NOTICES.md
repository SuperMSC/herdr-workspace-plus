# Mermaid renderer notices

The installed `mermaid.bundle.js` is a vendored, browser-free SVG renderer. It contains:

| Component | Version | License |
| --- | --- | --- |
| [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) | 1.1.3 | `licenses/beautiful-mermaid-MIT.txt` |
| [elkjs](https://github.com/kieler/elkjs/tree/0.11.1) | 0.11.1 | `licenses/elkjs-EPL-2.0.txt` |
| [entities](https://github.com/fb55/entities/tree/v7.0.1) | 7.0.1 | `licenses/entities-BSD-2-Clause.txt` |

The bundle was obtained from the public Preview Plus distribution at
`linziyanleo/herdr-mods@a47550e545fc4217861309ad31c01f35af068fbe/preview-plus`.
Its elkjs build adaptation is attributed there to
[`jjongkwann/herdr-files-plus@b43c4e3e1dc2305c952ef923abda78abea095f70`](https://github.com/jjongkwann/herdr-files-plus/tree/b43c4e3e1dc2305c952ef923abda78abea095f70)
(MIT, `licenses/Herdr-Files-Plus-MIT.txt`). The generated file retains the bundled legal comments.

The complete editable source for the modified elkjs component is the public npm
`elkjs@0.11.1` package plus the explicit, asserted patches in
`tools/mermaid/build.mjs`. The pinned public npm lockfile and entry point are
included in that directory. To reproduce, run `npm ci --ignore-scripts` in
`tools/mermaid`, then `node build.mjs --check`. esbuild 0.28.2 is build-only.
The installed renderer uses the existing Node prerequisite for one bounded helper
process per document (at most 24 diagrams, 15 seconds). No dependency installation,
network request, browser, model call or persistent service is used. Native image
elements display the generated SVGs; graph layout stays off the UI thread.

Markdown structure/navigation and the native SVG palette conversion in this mod
are independent implementations. This notice does not grant a license to unrelated
files in the referenced Preview Plus repository.
