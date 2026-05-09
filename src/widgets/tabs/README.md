# Prism widget: Tabs

## APG version

W3C ARIA Authoring Practices Guide — Tabs pattern, manual activation variant.
Pinned to APG editor's draft as of 2025-04-12 (version pin tracked in CHANGELOG).
Reference: <https://www.w3.org/WAI/ARIA/apg/patterns/tabs/>

## Props (placeholders)

| Placeholder | Shape | Notes |
|---|---|---|
| `{{tabsLabel}}` | plain text | Accessible name for the tablist. Escape upstream. |
| `{{tabId.N}}` | id string | Unique per page. Used for `aria-labelledby`. |
| `{{panelId.N}}` | id string | Unique per page. Referenced by `aria-controls`. |
| `{{tabLabel.N}}` | plain text | Visible tab label. Escape upstream. |
| `{{panelHTML.N}}` | sanitized HTML | Panel body. Sanitize upstream — the widget does not. |
| `{{selectedIndex}}` | integer (0-based) | Initially selected tab. Defaults to 0 if omitted. |

The template ships two tabs as a starting point. The widget-replacement transformer (chunk 04) clones the `[data-prism-tab]` / `[data-prism-panel]` rows N times to match the source carousel/tab count.

## Keyboard model

| Key | Behavior |
|---|---|
| Tab | Moves focus into / out of the tablist (one stop for the tablist + one for the active panel) |
| Arrow Right | Moves focus to the next tab and activates it |
| Arrow Left | Moves focus to the previous tab and activates it |
| Home | Moves focus to the first tab and activates it |
| End | Moves focus to the last tab and activates it |
| Enter / Space | Activates the focused tab |

This is the manual-activation variant of the APG pattern, but Arrow keys also activate (matches the firm's house style — consistent with the in-house design system).

## Decline rules

The widget-replacement transformer MUST refuse to substitute Prism Tabs for an existing div-soup tab pattern when:

1. **Nested anchors leave the page.** Any `<a href="...">` inside a candidate panel that points off-page (different host or different path) suggests the source widget is acting as a nav menu, not a tabset. Decline.
2. **Mixed interactive content controls the widget itself.** If the candidate tab labels contain form controls, decline — the source isn't a tab pattern.
3. **Panels contain `<form>` elements.** Browser autofill and validation cross panels in surprising ways under the manual-activation pattern. Decline; defer to author rework.
4. **Panel count is 1 or > 9.** A single panel is not a tabset. More than nine creates unusable focus order; recommend an accordion instead.

## Incomplete axe rules

None deferred — `axe-baseline.json` reports `incomplete: []`. The widget renders fully in jsdom for the baseline check.

## Print behaviour

When printed, the tablist is hidden and every panel is forced visible (each on a separate page-break-avoid block) so the printed PDF carries every tab's content.
