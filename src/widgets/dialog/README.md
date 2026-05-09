# Prism widget: Dialog

## APG version

W3C ARIA Authoring Practices Guide — Dialog (Modal) pattern.
Pinned to APG editor's draft as of 2025-04-12.
Reference: <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>

## Props (placeholders)

| Placeholder | Shape | Notes |
|---|---|---|
| `{{dialogId}}` | id string | Unique per page. Referenced by `aria-controls` on the trigger. |
| `{{titleId}}` | id string | Unique. Referenced by `aria-labelledby`. |
| `{{descId}}` | id string | Unique. Referenced by `aria-describedby`. The description paragraph hides itself when empty. |
| `{{title}}` | plain text | Dialog title. Escape upstream. |
| `{{descHTML}}` | sanitized HTML or empty | Optional description paragraph. |
| `{{contentHTML}}` | sanitized HTML | Body. Sanitize upstream. |
| `{{closeLabel}}` | plain text | Close-button accessible name. Default `"Close dialog"`. |
| `{{triggerLabel}}` | plain text | Visible launcher label. |

## Keyboard model

| Key | Behavior |
|---|---|
| Tab | Cycles forward through focusables inside the dialog (trapped while open) |
| Shift + Tab | Cycles backward |
| Escape | Closes the dialog and returns focus to the launching trigger |
| Enter / Space | Activates the focused dialog control |

The widget records the element that was focused before opening and restores focus there on close. Clicking the backdrop closes the dialog. The widget does NOT close on outside-click within the page (only the explicit backdrop closes).

## Decline rules

Refuse substitution when:

1. **Source dialog has multiple modal layers (dialog inside dialog).** Skill Loop's house style is one modal at a time. Decline; recommend rework.
2. **Source dialog hosts a `<form>` whose submit reloads the host SCO.** Focus restoration is meaningless after a navigation; refactor as a page first.
3. **Source dialog is a takeover of the entire viewport with no close.** That's a screen, not a dialog. Decline; recommend page split.
4. **Source dialog uses inert document siblings.** v5 doesn't ship inert polyfilling — decline rather than ship a partial fix.

## Incomplete axe rules

None deferred — the dialog renders in jsdom with `incomplete: []`.

## Print behaviour

The dialog is forced inline (position static, no fixed positioning), the backdrop is removed, and the close button is hidden so the printed page reads as ordinary inline content.
