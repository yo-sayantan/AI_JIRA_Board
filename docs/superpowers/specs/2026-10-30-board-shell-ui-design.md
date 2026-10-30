# Board Shell UI Redesign

## Scope

Redesign the main board shell: header, search, refresh and utility controls, filter and view toolbars, lane presentation, ticket cards, and footer. Preserve all existing data flow, Jira actions, drag-and-drop rules, board state, drawers, dialogs, reports, archive views, and server behavior.

## Direction

The target is a quiet operations console: dense, neutral, and easy to scan during repeated daily use. The redesign follows these principles in order:

1. Remove decorative UI patterns that do not improve comprehension.
2. Preserve React behavior while clarifying component responsibilities.
3. Use a consistent, domain-appropriate visual hierarchy.
4. Make controls and state understandable with keyboard and assistive technology.

## Visual System

- Use solid neutral surfaces for the page, header, controls, lanes, and cards.
- Remove board-shell backdrop blur, ambient background gradients, gradient text, gradient buttons, colored button shadows, and decorative entrance motion.
- Follow an approximate 70/20/10 balance: neutral canvas and content surfaces, subdued structural tones, and semantic accent colors.
- Keep lane colors only where they communicate state: slim markers, counts, selected states, and drag targets.
- Use the existing sans-serif font stack. Establish scan order through size, weight, spacing, and muted text rather than nested containers.
- Replace the gradient app-icon tile with a plain inline ticket mark.
- Keep icons only for recognizable actions. Do not place utility icons in colored decorative containers.
- Make Refresh the single strong call to action. Render utility actions as quiet, consistently sized icon buttons.
- Remove decorative footer copy from the repeated-use workspace.

## Layout and Components

### Header

- Keep identity and freshness together at the start of the header.
- Keep sprint, search, and the primary refresh action prominent.
- Group utility controls at the end.
- Use stable wrapping behavior: on constrained widths the header may form two intentional rows, but controls must not wrap unpredictably.
- Long sprint names and translated labels must truncate or wrap without compressing search below a usable width.

### Toolbars

- Present board filters as one labeled toolbar of native buttons.
- Expose the selected filter visually and with `aria-pressed`.
- Keep counts compact and aligned.
- Present Raised, Taken, and Completed as secondary destinations in a separate labeled group so they do not compete with lane filters.
- On narrow screens, allow toolbar groups to scroll horizontally instead of shrinking controls below usable sizes.

### Board and Lanes

- Preserve the app-shell scrolling model, sticky lane headings, horizontal board scrolling, drag-and-drop behavior, move gates, empty-lane rails, and calm-board timing.
- Reduce broad lane tinting and decorative borders. Use whitespace, alignment, headings, and restrained semantic accents to define lanes.
- Preserve clear drag targets and refusal messaging.

### Ticket Cards

- Preserve card content, click behavior, drag behavior, and existing status information.
- Normalize card padding, metadata alignment, title wrapping, and supporting-text hierarchy.
- Use border and background changes for hover, focus, selected, and drag states. Do not use decorative lift or scale.
- Ensure long keys, titles, branches, labels, and metadata wrap or truncate intentionally.

### React Structure

- Keep board data, sorting, state, and server interactions unchanged.
- Extract shared shell-control styles or small components only where they remove repeated markup or accessibility logic.
- Favor native elements and composition over custom interaction primitives.
- Do not add a UI dependency for this redesign.

## Accessibility

- Give search a connected label; it may be visually hidden.
- Name the search reset action “Clear search.”
- Use native buttons and links for all interactive shell controls.
- Add `aria-pressed` to toggle-like filters and selected view controls.
- Give each toolbar and control group an accessible name.
- Retain explicit accessible names on icon-only buttons.
- Use a useful heading hierarchy for the page, lanes, and ticket titles.
- Announce refresh progress and completion with a polite live region without repeatedly interrupting the user.
- Keep a visible focus indicator for every keyboard-operable control in both themes.
- If the input outline is suppressed, the search container must show an equivalent `:focus-within` indicator.
- Verify text and non-text contrast in light and dark themes.
- Add no decorative motion. Existing necessary state motion must continue to honor `prefers-reduced-motion` and the app’s motion-off setting.

## Responsive Requirements

- Preserve the dense desktop board.
- Maintain at least 44-by-44 CSS pixel touch targets for standalone icon controls at touch breakpoints.
- Keep search usable on tablet and mobile widths.
- Allow toolbars to scroll horizontally with visible focus and without hiding selected state.
- Prevent content overlap at 320 CSS pixels wide and at 200% text zoom.

## Error and Loading Behavior

- Preserve current data-loading, empty-state, error, and stale-data behavior.
- Keep refresh disabled/busy semantics and progress information.
- Do not alter fetch, retry, toast, or server behavior in this UI pass.

## Verification

- Add or update component tests for accessible names, selected filter state, search clearing, and toolbar semantics.
- Run TypeScript checking and the production build.
- Run the existing JavaScript and Python test suites.
- Check lints for all edited files.
- Inspect desktop and narrow/mobile screenshots in light and dark themes.
- Verify keyboard traversal, focus visibility, search operation, filter selection, ticket opening, and primary refresh semantics.

## Non-Goals

- Redesigning ticket drawers, settings, API-key dialogs, reports, Completed, Raised, or Taken views.
- Changing Jira move rules, server APIs, data contracts, sorting, or persistence.
- Replacing the existing icon set or adding a component library.
- Adding decorative animation or a new brand system.

## Acceptance Criteria

1. The first viewport reads as a work board, with search and Refresh clearly prioritized.
2. Neutral surfaces dominate; gradients, glow, glass blur, and decorative icon containers are absent from the board shell.
3. Lane colors remain recognizable without tinting large areas of the interface.
4. Existing board behavior and tests continue to pass.
5. Every shell control is keyboard reachable, visibly focused, semantically named, and correctly exposes selected or busy state.
6. The shell remains usable at desktop, tablet, and 320-pixel mobile widths in light and dark themes.
