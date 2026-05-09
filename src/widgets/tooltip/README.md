# Prism widget: Tooltip

## APG version

W3C ARIA Authoring Practices Guide — Tooltip pattern.
Pinned to APG editor's draft as of 2025-04-12.
Reference: <https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/>

This widget is also used as a primitive by `carousel` and `dialog` control buttons when those need an extended hint without claiming a label.

## Props (placeholders)

| Placeholder | Shape | Notes |
|---|---|---|
| `{{tooltipId}}` | id string | Unique per page. Referenced by `aria-describedby` on the trigger. |
| `{{triggerLabel}}` | plain text | Trigger button text. Escape upstream. |
| `{{tipText}}` | plain text | Tooltip body. Plain text only — APG forbids interactive content inside a tooltip. The transformer must reject candidates whose source tooltip contained links or buttons. |

## Keyboard model

| Key | Behavior |
|---|---|
| Tab to trigger | Tooltip becomes visible |
| Tab away from trigger | Tooltip becomes hidden |
| Escape (with focus on trigger) | Tooltip becomes hidden without moving focus |

Pointer hover on the trigger also shows the tooltip; `pointerleave` hides it. The tooltip itself never receives focus.

## Decline rules

Refuse substitution when:

1. **Source tooltip contains links, buttons, or other interactive content.** Use a popover or a dialog instead. Decline.
2. **Source tooltip has rich formatting that depends on visual layout** (tables, images). The Prism tooltip is plain text; rich content belongs in a dialog. Decline.
3. **Source tooltip is the sole label for a control with no visible text.** That's not a tooltip in APG terms — the control needs an `aria-label` instead. Refactor as 4.1.2 finding.
4. **Source uses `title` attributes only.** No replacement is needed; raise a 1.1.1/4.1.2 finding to add a proper label and leave the markup alone.

## Incomplete axe rules

None deferred — `axe-baseline.json` reports `incomplete: []`.

## Print behaviour

Tooltip text renders inline next to the trigger, parenthesized, so the printed page communicates the tooltip content even when the bubble is hidden in the browser.
