---
name: bob-ios-ui
description: "Build or change any native iOS Bob screen (apps/ios) with the shared design system so every screen looks and behaves the same. Use for any SwiftUI view, sheet, list, row action, state, haptic or animation in apps/ios/Bob, for redesign units, and when reviewing iOS UI."
---

# Bob iOS UI

Read `apps/ios/DESIGN.md` before writing or reviewing any view under `apps/ios`; it holds the shared
design rules and tokens. Then:

- Build screens from the shared design framework's components and tokens. Do not hand-roll colors,
  type, spacing, corner radii or haptics in a view.
- Reuse an existing screen's pattern (lists, rows, sheets, empty/loading/error states) before inventing
  one. Keep the app minimal, clean and consistent.
- Run `npm run check:ios-design` after the change; it fails on design drift.
- Run the Swift tests (`swift test --package-path apps/ios/BobKit`) and check the screen in the
  simulator, light and dark, before calling it done.
