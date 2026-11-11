# Native previews

These PNGs were captured from an isolated native Herdr window using sample data. They contain no real conversation excerpts or customer artifacts.

- activity-preview.png: production Timeline and SessionGallery classes, populated with helper-parsed fixture records and three original chart PNGs.
- delivery-preview.png: production Deliverables and ScreenPicker classes, populated with fixture metadata and a sample captured screen. The selected literal and excerpt are visible in the right preview.
- sidebar-proposal.png: a static comparison of the existing two-section structure with a possible unified project tree. This is the historical 0.11 proposal, not a screenshot of the 0.12 implementation. Version 0.12 supports the unified sidebar through an explicit migration.

Validation: 645 tests passed, all four production mods passed native check, and the screen picker was verified from the actual isolated Herdr terminals() DTO through hc get/read/get. Source and runtime are checked separately before delivery.

## 0.12 unified sidebar

unified-sidebar.png shows the actual 0.12 native Project Spaces + UnifiedSidebar components at 268px using sample data. It includes directories grouped inside Pinned and Needs attention, two-line task titles, a child agent, and the single whole-tree toggle. The snapshot is populated asynchronously by the production projection. All 782 tests now pass with the default test-file concurrency. The Deliverables lock and atomic-read races were fixed, with 14 deterministic filesystem race tests and 20 cross-process stress rounds (960 writes, 4,800 reads and 20 revision races) passing. Final native checks cover directory placement and both toggle states; an isolated layout resize retained metadata and supported exact restoration.

unified-hierarchy.png shows the same production components with a three-level project / workspace / terminal tree. Names and icons use consistent indentation; nested task metadata omits repeated parent names.


unified-directory-pins.png shows directory-level pinning with the current Files-aligned controls: a working task, ordinary shell, preview and empty tab remain under the pinned Tools directory. The Bash directory, its Done task and auxiliary shell appear together in Needs attention with count 1. This isolated native window had no live terminals and was stopped after verification.


toolbar-frame.png shows the production Sessions toolbar button selected inside its own native block. Its 26px height and 6px corner radius match the shipped panel buttons; removing the negative margin preserves the left round corners. The isolated preview app and its empty core were stopped after verification.


The 0.12.1 sidebar update uses transparent directory rows, persistent direct-pin controls, 38px Detailed workspace rows and 28px Compact rows. Base row spacing is 2px, with 6px extra at project boundaries. All 782 tests and the installed native check passed. Earlier sample PNGs retain the original 0.12 card styling; the latest layout was checked in the running app without publishing live conversation content.


Version 0.12.1 uses a shared 78px trailing dock for projects, directories and terminals: a 19px pin slot, 3px gap and 56px right-aligned summary, all with a 5px right inset. Details and action buttons are transparent at rest, with hover feedback following the shipped Spaces/chrome controls. Detailed status text shares its icon column right edge and remains aligned on resize; hovering reveals the already-reserved pin control without narrowing or reflowing titles.
