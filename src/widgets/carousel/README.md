# Prism widget: Carousel

## APG version

W3C ARIA Authoring Practices Guide — Carousel (Tabbed) pattern, manual rotation only.
Pinned to APG editor's draft as of 2025-04-12.
Reference: <https://www.w3.org/WAI/ARIA/apg/patterns/carousel/>

**No autoplay.** APG allows autoplay with a pause button; Skill Loop's house style is manual-only because most clients enable LMS players that ignore visibility/blur events. A user who Tabs out and Tabs back must find the carousel exactly where they left it.

## Props (placeholders)

| Placeholder | Shape | Notes |
|---|---|---|
| `{{carouselLabel}}` | plain text | Region label. Escape upstream. |
| `{{prevLabel}}` / `{{nextLabel}}` | plain text | Button labels. Default to `"Previous slide"` / `"Next slide"` if blank. |
| `{{slideId.N}}` | id string | Unique per page. |
| `{{slideLabel.N}}` | plain text | Per-slide accessible name (e.g. `"Slide 2 of 4: Onboarding"`). |
| `{{slideHTML.N}}` | sanitized HTML | Slide body. Sanitize upstream. |

Repeat the `[data-prism-slide]` block once per slide.

## Keyboard model

| Key | Behavior (focus on prev/next button) |
|---|---|
| Tab | Standard focus order |
| Enter / Space | Activates the focused button |
| Arrow Right | Advances to the next slide |
| Arrow Left | Goes to the previous slide |
| Home | First slide |
| End | Last slide |

Slide content uses the host SCO's natural tab order. The carousel does not trap focus.

## Decline rules

Refuse substitution when:

1. **Source autoplays.** Replacing autoplay with manual changes the author's intent. Defer; raise as a 2.2.2 (pause/stop) finding.
2. **Slides contain `<form>` elements.** Hidden form controls behave inconsistently across browsers and submit handlers. Decline.
3. **Slides contain anchors with `target="_self"` to in-package routes.** SCORM in-package navigation depends on slide-state lifecycle the carousel hides. Decline.
4. **Source uses CSS-only sliding (no JS).** That is a slideshow, not a widget; recommend leaving it alone or converting to stacked sections.
5. **Slide count is 1.** Not a carousel — strip the wrapper.

## Incomplete axe rules

None deferred — `axe-baseline.json` reports `incomplete: []`.

## Print behaviour

Controls hidden; every slide is forced visible with page-break-avoid blocks between them.
