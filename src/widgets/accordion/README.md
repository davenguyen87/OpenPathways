# Prism widget: Accordion

## APG version

W3C ARIA Authoring Practices Guide — Accordion pattern, built on the Disclosure pattern.
Pinned to APG editor's draft as of 2025-04-12.
Reference: <https://www.w3.org/WAI/ARIA/apg/patterns/accordion/>

## Props (placeholders)

| Placeholder | Shape | Notes |
|---|---|---|
| `{{headingLevel}}` | tag name | Heading element for each section. Default `h3`. The transformer is responsible for choosing a level that fits the host page hierarchy. |
| `{{headerId.N}}` | id string | Unique per page. |
| `{{panelId.N}}` | id string | Unique per page. |
| `{{headerLabel.N}}` | plain text | Visible label on the trigger. Escape upstream. |
| `{{panelHTML.N}}` | sanitized HTML | Panel body. Sanitize upstream. |
| `{{expanded.N}}` | `"true"` or `"false"` | Initial state. Default closed. |

Repeat the `[data-prism-section]` block once per section.

## Keyboard model

| Key | Behavior |
|---|---|
| Tab | Moves focus through every section trigger (and into expanded panels) |
| Enter / Space | Toggles the focused section |
| Arrow Down | Moves focus to the next trigger |
| Arrow Up | Moves focus to the previous trigger |
| Home | Moves focus to the first trigger |
| End | Moves focus to the last trigger |

Only the trigger handles keyboard input; panel content uses the host SCO's natural tab order.

## Decline rules

Refuse substitution when:

1. **Source has any open-by-default behaviour that depends on URL hash.** Hash-based section navigation can't be preserved without rewriting outbound anchors; defer to author rework.
2. **Source contains overlapping triggers.** A "click anywhere on the row" handler that includes the panel content cannot be cleanly split into trigger + region. Decline.
3. **Single section.** Use a Disclosure component, not an accordion. (Out of scope for v5.)
4. **Triggers contain block-level elements.** The trigger must be a single button; nested `<div>` headers with their own focus targets indicate the source is doing more than disclosure. Decline.

## Incomplete axe rules

None deferred — `axe-baseline.json` reports `incomplete: []`.

## Print behaviour

All panels render expanded; chevrons hidden; backgrounds neutralized so the printed PDF reads like ordinary headed sections.
