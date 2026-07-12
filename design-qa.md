# Hydra Desktop v2 Design QA — Production Density Amendment

**Source visual truth:**

- `docs/desktop-v2/assets/terminal-first-main.png` — product composition and Terminal-first hierarchy
- `docs/desktop-v2/assets/codex-production-sidebar.png` — production Sidebar palette, row density, disclosure, and footer
- `docs/desktop-v2/assets/codex-production-context.png` — production floating-inspector density

**Implementation screenshots:**

- `docs/desktop-v2/qa/implementation-density-light-1280x800.png`
- `docs/desktop-v2/qa/implementation-density-tabs-light-1280x800.png`
- `docs/desktop-v2/qa/implementation-density-light-1487x1058.png`
- `docs/desktop-v2/qa/implementation-density-dark-980x640.png`

**Measured evidence:** `docs/desktop-v2/qa/density-geometry.json`

**State:** freshly packaged macOS app; light selected Copilot with Context open, multi-tab Copilot Context with 10 managed Workers, Worker Context with unknown runtime, and dark minimum viewport

**Dynamic-data rule:** live session names, counts, terminal bytes, runtime states, and workdirs may differ from illustrative sources. Component geometry, hierarchy, density, accessible state treatment, and fixed copy may not drift.

## Findings

No actionable P0, P1, or P2 differences remain after the production-density amendment.

The focused comparisons show the intended result:

- Sidebar compositing is `(216, 223, 222)` against the production reference's dominant `(216, 224, 222)`, a one-channel delta.
- Sidebar and production reference are both 296 px wide in the focused comparison.
- Copilot rows are 44 px and Worker rows are 34 px; the prior 56/42 px rhythm is gone.
- The footer is 44 px in both the production reference crop and implementation.
- Context is 320 px rather than the prior 352 px, uses 11 px facts, 40 px managed-Worker rows, and intrinsic height for short content.
- Multi-tab Context begins at y = 114 px, below the TabBar and SessionHeader rather than overlapping them.
- Unknown runtime stays truthful: the visible value is a quiet em dash, while `title` and `aria-label` remain `Unknown`.

The remaining P3 difference is intentional: Hydra retains Search, New Copilot, Worker grouping, and its own product mark instead of copying Codex product navigation or branding.

## Full-view comparison evidence

- Same-size composition comparison, source left and implementation right: `docs/desktop-v2/qa/comparison-density-full.png`
- Final 1487 × 1058 implementation: `docs/desktop-v2/qa/implementation-density-light-1487x1058.png`
- Final default packaged-app state: `docs/desktop-v2/qa/implementation-density-light-1280x800.png`
- Final dark minimum viewport: `docs/desktop-v2/qa/implementation-density-dark-980x640.png`

The full comparison is used for Terminal prominence, shell hierarchy, floating behavior, and overall density. Runtime content is live and therefore intentionally differs.

## Focused-region comparison evidence

- Sidebar production reference vs implementation: `docs/desktop-v2/qa/comparison-density-sidebar.png`
- Context production reference vs implementation: `docs/desktop-v2/qa/comparison-density-context.png`
- Footer production reference vs implementation: `docs/desktop-v2/qa/comparison-density-footer.png`
- Disclosure-restored interaction state: `docs/desktop-v2/qa/interaction-density-disclosure.png`

Focused comparisons are required because small type, the selected tint, footer height, and Context fact tracks are not readable in the full 2974-pixel-wide image.

## Frozen geometry

| Surface | Contract | Packaged implementation | Delta |
|---|---:|---:|---:|
| Sidebar default | 296 px | 296 px | 0 px |
| Sidebar bounds | 228–320 px | 228–320 px | 0 px |
| Copilot row | 44 px | 44 px | 0 px |
| Worker row | 34 px | 34 px | 0 px |
| Sidebar footer | 44 px | 44 px | 0 px |
| Context, default | 320 px | 320 px | 0 px |
| Context, 980 px viewport | 304 px | 304 px | 0 px |
| Context managed-Worker row | 40 px | 40 px | 0 px |
| Multi-tab Context top | 114 px | 114 px | 0 px |

## Required fidelity surfaces

- **Fonts and typography:** Hydra and the production references use the macOS system text stack. Sidebar names are 12 px with 10 px summaries; Context titles are 14 px, facts and rows are 11 px, with system antialiasing and restrained optical weights. Long names truncate; full runtime meaning remains accessible.
- **Spacing and layout rhythm:** Sidebar is 296 px, Copilot/Worker rows are 44/34 px, the footer is 44 px, Context is 320 px with 58 px fact labels and an 8 px track gap, and Worker rows are 40 px. Short Context content uses intrinsic height; long content scrolls inside the viewport cap.
- **Colors and visual tokens:** the final Sidebar composite is `(216, 223, 222)` versus the reference's dominant `(216, 224, 222)`. Selection becomes `(208, 215, 214)`, matching the production neutral tint. Semantic orange, red, green, and neutral runtime colors retain their meaning.
- **Image quality and asset fidelity:** the runtime UI uses Hydra's existing vector mark and the established Lucide line-icon family. No placeholder asset, emoji, CSS art, handcrafted SVG, or text-glyph icon was introduced. The Codex crops are documentation references only.
- **Copy and content:** Hydra-specific labels remain truthful (`New copilot`, `Managed workers`, `Local Tasks`, `Attention history`). `Unknown` is not replaced at the data layer and remains available through tooltip and accessibility text.
- **Responsiveness and accessibility:** the 980 × 640 dark viewport has body scroll size exactly 980 × 640. All disclosure controls are semantic buttons with `aria-expanded`; Search reveals all matches; the runtime dash retains an accessible name.

## Comparison history

1. **Original concept pass — superseded:** the implementation matched the image-generated anchor at 310 px Sidebar, 352 px Context, 56 px Copilot rows, and 96 px footer.
2. **Production review — blocked by P1/P2:** user comparison against Codex revealed a Sidebar that was too blue-green, oversized navigation/Context typography, non-collapsible Local Tasks, repeated wide `Unknown` labels, and a footer over twice the production height.
3. **Density iteration — blocked by P2:** initial tightening fixed width and rows, but the first sampled Sidebar composite was `(210, 219, 218)`, too dark, and short Copilot Context still filled the window with empty space.
4. **Final iteration — passed:** adjusted the token to composite at `(216, 223, 222)`, made Context content-height with a viewport max, added multi-tab top offset, and repeated full plus focused comparisons. No actionable P0/P1/P2 differences remain.

## Interaction checks

- Context open, closed, and reopened preserved the active Terminal rectangle exactly at `305,64,963 × 720`.
- Copilot disclosure rendered 5 of 7 sessions, expanded to 7 with `Show less`, then returned to 5.
- Local Tasks changed from 2 rows to 0 when collapsed and restored to 2 when reopened.
- Search uses the pure disclosure policy to show all matching rows without a redundant Show more control.
- Opening a second tab moved Context from y = 72 to y = 114; it did not cover SessionHeader.
- Ten unknown managed-Worker states rendered ten quiet dashes. Worker Context exposed `text = —`, `title = Unknown`, and `aria-label = Unknown`.
- Long Worker Context used a 630 px client body over 788 px content and scrolled inside the drawer.
- At 980 × 640 dark, Context measured `660,114,304 × 510`, footer remained 44 px, and the document had no horizontal or vertical overflow.
- Chromium monitoring across the final interactions reported zero `Runtime.exceptionThrown` events and zero error-level `Log.entryAdded` events.

## Implementation checklist

- [x] Production Sidebar palette sampled and matched
- [x] Copilot, Worker, Context, and footer density tightened
- [x] Copilot Show more / Show less implemented
- [x] Local Tasks independent collapse implemented
- [x] Search/disclosure behavior regression-tested
- [x] Unknown runtime compacted without losing semantics
- [x] Short and long Context height behavior verified
- [x] Multi-tab Context offset verified
- [x] Light 1280 × 800 and 1487 × 1058 comparisons completed
- [x] Dark 980 × 640 overflow and scroll ownership verified
- [x] Fresh packaged macOS app and console verified

## Follow-up polish

- P3 only: replace the generic Electron application icon during a separate brand-packaging pass; it is unrelated to this density correction.

final result: passed
