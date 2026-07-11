# Hydra Desktop v2 Design QA

**Source visual truth:** `docs/desktop-v2/assets/terminal-first-main.png`

**Implementation screenshot:** `docs/desktop-v2/qa/implementation-light-1487x1058.png`

**Viewport:** 1487 × 1058 renderer pixels, device scale factor 1

**State:** light appearance, selected Copilot, connected Terminal, Copilot Context open

**Dynamic-data rule:** live session names, counts, terminal bytes, runtime states, and workdirs may differ from the illustrative source; their component geometry and presentation may not.

## Findings

No actionable P0, P1, or P2 visual differences remain in the reference state.

The remaining P3 differences are intentional:

- Native macOS traffic lights are absent from the renderer-only capture. The Electron window continues to use `titleBarStyle: hiddenInset` and the approved traffic-light position; native chrome is verified separately in the packaged app.
- The renderer uses Hydra's existing vector product mark from `packages/extension/resources/hydra-activitybar.svg`, copied into the Desktop package, rather than treating the image-generated approximation as a new logo.
- Live Hydra data does not reproduce the mock's illustrative names, worker count, terminal transcript, or attention values.

## Full-view comparison evidence

- Combined source and implementation: `docs/desktop-v2/qa/comparison-light-1487x1058.png`
- Iteration contact sheet: `docs/desktop-v2/qa/comparison-history.png`
- Final light implementation: `docs/desktop-v2/qa/implementation-light-1487x1058.png`
- Final dark minimum-viewport implementation: `docs/desktop-v2/qa/implementation-dark-980x640.png`
- Fresh packaged-app renderer: `docs/desktop-v2/qa/packaged-light-1280x800.png`

## Focused-region comparison evidence

- Sidebar, creation controls, hierarchy, and footer: `docs/desktop-v2/qa/comparison-sidebar.png`
- Session header and Terminal utility line: `docs/desktop-v2/qa/comparison-chrome.png`
- Copilot Context geometry and information hierarchy: `docs/desktop-v2/qa/comparison-context.png`

Focused comparisons are required because the full 2976-pixel-wide comparison cannot show small typography, icon, border, and spacing differences at readable scale.

## Reference geometry

| Surface | Source | Implementation | Delta |
|---|---:|---:|---:|
| Sidebar / main boundary | x = 310 | x = 310 | 0 px |
| Session header | 310, 0, 1177 × 54 | 310, 0, 1177 × 54 | 0 px |
| Terminal | 319, 64, 1156 × 978 | 319, 64, 1156 × 978 | 0 px |
| Terminal utility line | 45 px | 45 px | 0 px |
| Context | 1107, 84, 352 × 805 | 1107, 84, 352 × 805 | 0 px |
| Context radius | 12 px | 12 px | 0 px |
| Sidebar footer | 96 px | 96 px | 0 px |

## Required fidelity surfaces

- **Fonts and typography:** the shell uses the macOS system stack with compact optical weights; title, utility, row, and fact sizes match the reference hierarchy. Terminal uses Menlo/Monaco with CJK fallbacks at 13 px and 1.2 line height. Long live values truncate or wrap only in the surfaces designed for them.
- **Spacing and layout rhythm:** all major reference rectangles match exactly. Sidebar rows, search/create controls, Terminal padding, 45 px utility line, Context sections, 45 px managed-worker rows, radii, borders, and elevation were checked in focused comparisons.
- **Colors and tokens:** sampled reference/implementation values are sidebar `(228,234,233)` / `(227,234,234)`, header `(252,253,253)` / `(252,253,253)`, and Terminal `(21,26,27)` / `(21,25,28)`. These one-channel deltas are antialiasing/color-compositing variance, not a semantic token mismatch.
- **Image quality and asset fidelity:** no placeholder imagery, CSS art, inline SVG art, emoji, or text-glyph icons remain. UI icons come from one Lucide family. The only product mark is Hydra's existing vector asset.
- **Copy and content:** fixed UI copy matches the visual target where applicable (`New copilot`, `Copilot context`, `Create worker`, `Attention history`) while runtime-derived values stay truthful.
- **Icons:** search, split-create, attention, branch/folder, header utilities, copy, row chevrons, Context actions, and footer settings were checked for family, stroke, alignment, and state behavior.
- **Responsiveness and accessibility:** the 980 × 640 viewport has `bodyScrollWidth = 980` and `bodyScrollHeight = 640`; Context is 320 × 540 at `(632,84)` and the Terminal remains underneath it. Controls use semantic buttons, accessible labels, keyboard focus, and reduced-motion handling.

## Comparison history

1. **Iteration 0 — blocked by P1:** Sidebar was 340 px, the header was two-line, the Terminal utility line was 34 px, and Context was 372 px wide and full-height. Fixed the application grid, header composition, Terminal padding, and Context frame.
2. **Iteration 1 — blocked by P2:** navigation counts and runtime tokens were visually noisy; header utilities, sidebar footer, split creation, and target row hierarchy were incomplete. Rebuilt those surfaces with direct v2 data and the approved line-icon language.
3. **Iteration 2 — blocked by P2:** search shortcut treatment, Context overflow scrollbar, copy treatment, Context header menu, worker chevrons, and several row offsets still drifted. Fixed the controls and removed visible scrollbar width from measured content.
4. **Iteration 3 — blocked by P2:** Environment facts and scope-summary text were vertically misaligned despite the correct outer rectangle. Rebalanced section margins and asymmetric summary padding.
5. **Final pass:** repeated the full-view and three focused comparisons. No actionable P0/P1/P2 findings remained.

## Interaction checks

- Context close and reopen preserved the Terminal rectangle exactly at `319,64,1156 × 978` in all three states.
- `Cmd+K` focused Search; filtering for `codex` preserved `COPILOTS`, `WORKERS`, `REPOSITORIES`, and `LOCAL TASKS` grouping.
- The split-create menu exposed Code Worker and Local Task. Opening Local Task preserved Worker/Task selection and preset the active Copilot as parent.
- New Copilot exposed Workdir, Agent, Name, Plan mode, and optional Initial task.
- A code Worker opened on Terminal, switched to Diff, loaded 14 changed files, and switched back without losing the mounted Terminal.
- Maximize hid Sidebar and Context; Restore returned both and preserved the active Terminal.
- Context, session, and footer overflow menus opened with their expected actions.
- Search and split-create evidence: `docs/desktop-v2/qa/interaction-search.png` and `docs/desktop-v2/qa/interaction-create-menu.png`.
- A reload-time Chromium `Runtime.exceptionThrown` and `Log.entryAdded` monitor returned an empty list: no exceptions or console error entries.
- The fresh `dist/mac-arm64/Hydra.app` launched successfully, loaded the packaged Hydra mark, preserved the 310 px Sidebar default, and opened Context without changing its `319,64,949 × 720` Terminal rectangle. A packaged-app reload monitor also returned no exception or error entries.

## Implementation checklist

- [x] Exact reference-state geometry
- [x] Required typography, color, icon, content, and asset passes
- [x] Light 1487 × 1058 comparison
- [x] Dark 980 × 640 and overflow check
- [x] Search, creation, Context, Terminal/Diff, maximize/restore interactions
- [x] Console error check
- [x] P0/P1/P2 iteration loop complete

## Follow-up polish

- P3 only: capture a native-window screenshot on a machine/process with macOS Screen Recording permission if future QA needs the OS-rendered traffic lights inside the same bitmap.

final result: passed
