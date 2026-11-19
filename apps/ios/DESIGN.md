# Bob iOS design

The single source of rules for every native screen. The code that enforces it lives in `Bob/Bob/DesignSystem/`; the check that keeps it enforced is `npm run check:ios-design`. Build screens with the `bob-ios-ui` skill.

Visual reference: the "Detailed flows" page of the [redesign canvas](https://claude.ai/artifact/BxnouxKL9zk7uWq8JKQpue). Feature review and decisions: [Bob iOS review](https://claude.ai/artifact/ERWbo4w2APi5qYXLBryYWg). Product context: `PRODUCT.md`.

Direction (owner, 2026-11-05): Miles monochrome palette and type, Dime structure, no stats unless the screen is about stats, and strict consistency of navigation, actions, colour and type.

## 1. Colour

Five colours. Nothing else, except Bob's artwork.

| Token (`BobColor`) | Light | Dark | Use |
| --- | --- | --- | --- |
| `ink` | #121214 | #F5F5F7 | text, primary buttons, selected tab |
| `muted` / `ink2` | #5E5E66 | #A1A1AA | secondary text, captions, unselected tabs |
| `controlLine` | #85858E | #7A7A83 | dividers (at 30%), field borders, switch off track |
| `wash` / `tint` | #F4F4F6 | #1C1C1F / #26262B | fields, chips, pressed rows, Bob's bubble |
| `dangerText` | #C9281C | #FF6B5E | now, unread, live, and destructive text |

- The page is white in light mode and #0E0E10 in dark.
- Red means "now", "unread", "live", or "this destroys something". Never decoration.
- `accent` is ink. There is no brand tint on controls.
- Contrast is tested in `BobKit/Tests/BobKitTests/BobAppearanceTests.swift`; every text pair passes 4.5:1, every boundary 3:1.
- Never write a colour literal in a screen. Use `BobColor`.

## 2. Type

One monospaced family (SF Mono), regular and bold. Six roles, all Dynamic Type.

| Role (`BobFont`) | Text style | Size | Use |
| --- | --- | --- | --- |
| `title` | `.title` | 28 bold | tab root titles, lowercase |
| `lead` | `.title3` | 20 bold | one lead line per screen: next event, a detail title |
| `body` / `bodyStrong` | `.subheadline` | 15 | messages and rows; row titles bold |
| `secondary` | `.footnote` | 13 | sublines, meta, notes |
| `label` | `.caption` | 12 | section labels, lowercase |
| `control` | `.caption2` | 11 | the word under an icon |

- Old names (`greeting`, `heading`, `rowTitle`, `subline`, `meta`, `caption`, `tabLabel`) map onto these roles. Prefer the new names in new code.
- Never `.font(.system(size:))` or a raw text style in a screen.
- UI labels are lowercase ("inbox", "new", "pinned"). People's content keeps its own case.

## 3. Navigation

- Five tabs, fixed order: chats, today, bob, spaces, you. Each keeps its own stack.
- The Bob tab's icon is `BobVisorIcon`, a line drawing of Bob's visor, outlined when unselected and filled when selected like the other tabs (owner, 2026-11-05). Bob's artwork appears inside screens, never in the tab bar.
- **Tab root** (`.bobRoot`): large lowercase title; search field, then filter tabs, under it. Top right: `inbox`, then at most one primary action (`new`, `add`). Nothing else.
- **Child page** (`.bobChild`): native back ("‹ parent"), title, and under it who can see it ("private · just you and bob", "family · 4 people"). At most one labelled action on the right.
- **Sheets** for creating and editing: grab handle, `cancel · title · save` (`BobSheetBar`). Read-only sheets: `close`. Swiping down asks first if anything was typed.
- **Full screen** only for voice.
- A route never jumps to another tab. The one exception is the inbox, which opens where the notification happened.
- Bob's features (apps, routines, memory, insights, timeline, tools, connections, devices) live in the Bob tab. You is account and preferences only. Group chats live in chats, under the groups filter.

## 4. Actions

Declare a thing's actions once, as `[BobAction]`. The framework draws them everywhere:

- **Tap** opens.
- **Swipe left** shows up to three actions marked `inSwipe`, destructive at the edge.
- **Press and hold** shows every action, destructive last, in red.
- **VoiceOver** gets every action as a named action.
- **Detail page** shows the same actions as buttons (`BobActionList`), destructive last.

Safety is part of the action, never improvised:

| Kind | Safety |
| --- | --- |
| can be undone (archive, complete, pin) | `.undo`: do it, show the undo bar |
| cannot be undone, or affects other people | `.confirm`: one confirmation dialog |
| harmless | `.none` |

Never zero safety on something destructive, never more than one confirmation.

Buttons: primary is filled ink (`BobPrimaryButtonStyle`), secondary is outlined (`BobSecondaryButtonStyle`), destructive is red text only. Every icon has a word under or beside it (`BobBarButton`); icon-only controls are not allowed.

## 5. States

Every list and detail names its state, using the shared views:

- loading: `BobLoading("loading chats")`, words, not only a spinner;
- empty: `BobEmpty` with one next step;
- failed: `BobLoadFailure`, whose icon matches the cause (wifi only when offline);
- stale: `BobStaleNote` above the content when a refresh failed after data loaded.

## 6. Motion and feedback

Use `BobMotion` and `BobFeedback`; never hand-roll a spring or a haptic.

| Moment | Motion | Feedback |
| --- | --- | --- |
| open a row | system push | none |
| switch tab | instant | selection |
| add, new, edit | sheet rises | none |
| press and hold | menu grows from the row | light impact (system) |
| swipe action fires | row settles | `BobFeedback.action` |
| send | message slides up (`BobMotion.standard`) | `BobFeedback.action` |
| reply finished, saved, done | check fills; Bob nods once | `BobFeedback.success` |
| error | none | `BobFeedback.error` |

Reduce Motion turns every move into a 150 ms fade (`BobMotion.standard` does this for you). Bob's artwork moves only in response to a real action.

## 7. Copy

- Lowercase labels, short. Name things as people see them ("inbox", not "notifications feed").
- Errors say what happened and the one next step. "Couldn't …", never "could not".
- No stats unless the screen is about stats (usage, insights).

## 8. Done means

A screen is done when it uses only `DesignSystem` pieces, `npm run check:ios-design` passes, it works in light, dark and the largest text size, and every action is reachable without a gesture.
