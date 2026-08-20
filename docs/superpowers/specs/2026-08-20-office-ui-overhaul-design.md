# Office UI Overhaul — Design

Date: 2026-08-20 · Status: approved in brainstorm, pending final user review
Branch: `office-ui` (from `service-story` @ 86b8f2e)

## Goal

Give the office app a modern, light-first shell — side navigation plus top
bar, modeled on app.apollo.io — with a navigation structure that covers
**everything in CORE.md**, built or not. Unbuilt areas appear as designed
placeholder pages, honestly labeled. The technician PWA is untouched.

## Scope

**In:** the office app (`apps/web/app/(office)`), the login page's visual
treatment, ~18 new thin routes, one new real page (staff roster), a design
token system, two new verification scripts.

**Out (explicitly):** the technician PWA (`/tech`), the write layer, every
API route, `ActionForm`/`Fields` internals, the gate-code and photo
surfaces, authentication, any Google integration, any dark theme, any CSS
framework, any fake/demo data on placeholder pages.

## Decisions made in brainstorm

1. **Office app only.** The PWA is a deliberately different surface
   (ADRs 0004/0006); it keeps its purpose-built phone UI.
2. **Navigation pattern A — Apollo-faithful:** 64px icon rail (full
   height) + 200px section panel showing the active section's
   subsections + 52px top bar over the content column.
3. **Light-first**, palette derived from the Champlain Pools & Spa site
   colors, with WCAG AA (≥ 4.5:1) enforced on every text-bearing pair.
4. **Approach C:** new shell + token reskin + targeted markup retouch of
   existing pages; no component-library rebuild.
5. **Google Workspace is the platform's declared home** — Calendar sync,
   Gmail into the timeline, and eventually Google sign-in. In this effort
   it appears only as placeholder/Integrations content. The identity
   redirect (Clerk → Google) contradicts ADR 0007's stated destination and
   should get its own ADR when auth work begins; this spec records the
   intent, nothing more.

## Navigation taxonomy

The two-level tree. Status vocabulary: **built** (page exists and works),
**partial** (data/schema exists, page is a placeholder that says so),
**planned** (placeholder only).

| Section | Subsection | Route | Status |
|---|---|---|---|
| Home | — (no subnav) | `/` | built (search-first landing) |
| Customers | Directory | `/customers` | built-thin: same search UI extracted to a shared component, rendered at its own route so the Customers section can be active (Home keeps `/`) |
| | New customer | `/customers/new` | built |
| | *(records at `/customers/[id]` carry the timeline; communications stay per-customer — "one timeline")* | | |
| Schedule | Day board | `/schedule` | built |
| | Live status | `/schedule/live` | partial (GPS breadcrumbs exist in `work_order_ping`) |
| | Routes | `/schedule/routes` | planned |
| Service | Calendar | `/service/calendar` | planned (the dedicated service schedule; promises Google Calendar sync) |
| | Jobs | `/service/jobs` | partial (work orders exist; no cross-customer list) |
| | Follow-ups | `/service/followups` | partial (`incomplete_reason` exists; no worklist page) |
| | Water tests | `/service/water` | partial (per-customer records exist) |
| | Checklist templates | `/service/templates` | partial (`TASK_TEMPLATES` in code) |
| Inventory | Items | `/inventory/items` | partial (item master + barcodes in write layer) |
| | Stock levels | `/inventory/stock` | planned |
| | Large items | `/inventory/large-items` | planned (spas by model/color — named in CORE.md) |
| | Transfers | `/inventory/transfers` | planned (store ↔ truck) |
| | Channels | `/inventory/channels` | partial (channel seam in code) |
| Purchasing | Purchase orders | `/purchasing/orders` | planned |
| | Vendors | `/purchasing/vendors` | planned |
| | Reorder suggestions | `/purchasing/reorder` | planned |
| Sales & POS | Quotes | `/sales/quotes` | planned |
| | Orders | `/sales/orders` | planned |
| | Register | `/sales/register` | planned |
| | Payments | `/sales/payments` | planned (combined payments, surcharge) |
| Reports | Dashboards | `/reports/dashboards` | planned |
| | Forecasting | `/reports/forecasting` | planned |
| | Ask | `/reports/ask` | planned (natural-language search / AI) |
| Settings | Staff | `/settings/staff` | **new real page** (read-only roster) |
| | Integrations | `/settings/integrations` | planned (Google Workspace flagship; Podium, QuickBooks, fleet) |
| Technician app | — | link out to `/tech` | existing surface, unchanged |

CORE.md coverage: every Current-Challenges and Desired-Future-State item
maps to a destination above. Deliberate folds: address validation lives
inside customer/property forms (not nav); photos and property profiles live
on the customer record.

## Shell anatomy

- **Icon rail** (64px, full height, white surface, subtle right border):
  logo slot at top (green-circle placeholder until the real logo file is
  provided), eight section icons with 10px labels, Settings pinned near the
  bottom, "Technician app" last and visually separated (it leaves the
  app). Active section carries the blue accent.
- **Section panel** (200px): renders only when the active section has
  subsections (Home has none). Section name as header; subsection links;
  active item gets an accent bar; unbuilt items carry a small `planned`
  chip in the nav itself.
- **Top bar** (52px, spans the content column): global customer search on
  the left — a plain GET form to `/` so the home page remains the single
  search implementation; the `/` key focuses it from anywhere. On the
  right, the signed-in name + role badge + sign out, permanently visible
  (shared counter machine; every write carries that name).
- **Content column**: consistent page header (title + contextual actions)
  on a `#f7f8fa` canvas with white cards.
- **Active-state logic**: section derives from route prefix
  (`/customers/*` → Customers, etc.), so deep pages still show where they
  are.
- **Narrow widths**: designed for ≥1024px; at ~768px the panel collapses
  behind a toggle. No further mobile work — the phone surface is the PWA.

## Placeholder template

One shared component, reused by every unbuilt page:

1. Page header: section/subsection name + phase chip (`Phase 3 ·
   inventory`).
2. One paragraph of what the screen will do, written from CORE.md's own
   language.
3. Bullet list of the specific CORE.md aims it answers.
4. An honest status line: `designed` / `begun in code` / `not started` —
   consistent with DEMO.md's vocabulary.
5. Where the capability partially exists today, links to it (e.g.
   Service → Jobs links to the day board and customer records).

**No fake data, no mock charts, no lorem.** A placeholder that looks like
a working dashboard would lie in a repo whose culture is honest status.
These pages look intentional and clearly planned.

## Visual system

### Brand palette (source: Champlain Pools & Spa site CSS)

```
--dim-grey:         #4d4d4d
--dodger-blue:      #0092db
--yellow:           #fff508
--medium-sea-green: #3db54e
--tomato:           #f56b49
--gold-2:           #ffe600
--gold:             #fbcc28
```

### Token mapping

| Token role | Source | Rule |
|---|---|---|
| Accent (active nav, links, primary buttons) | `#0092db` | raw hue for fills/identity; **derived darker step (~`#0074af`) wherever it carries text or text sits on it** — raw blue on white is ~4.0:1, under AA |
| Body text | `#4d4d4d` | 8.9:1 on white; derived lighter greys for secondary text must stay ≥ 4.5:1 |
| Canvas / surfaces | derived | `#f7f8fa`-class canvas, white cards, light grey borders |
| Success / working | `#3db54e` | darkened variant for text |
| Danger / urgent / over-capacity | `#f56b49` | darkened variant for text (the board's over-capacity figure becomes brand tomato) |
| Warning / attention chips | `#fbcc28` / `#ffe600` | tinted backgrounds with dark text only; never yellow text on light |

**The contrast rule is hard:** every text-bearing color pair ships at
≥ 4.5:1 (WCAG AA), verified by script (below). Raw brand hues are reserved
for non-text-gated uses.

Also in the token block: spacing scale, type scale, radii, shadows —
replacing ad-hoc values for office surfaces.

## File structure

### CSS scoping (the trap and its fix)

`globals.css` is imported by the **root** layout and therefore styles the
office app, login, **and the technician PWA**. Flipping it light would
break the PWA. The split:

- `apps/web/app/globals.css` — shrinks to true globals (reset, base
  typography, primitives genuinely shared with `/tech`). Visually
  unchanged for the PWA.
- `apps/web/app/(office)/office.css` — **new**, imported only by the
  office layout: the full token block and every shell + office-component
  style. Light theme cannot leak.
- `apps/web/app/login/login.css` — small light restyle of the sign-in card
  (both surfaces enter through it; no shell chrome).

### Navigation as data

`apps/web/lib/nav.ts` — the approved tree as one typed constant: label,
href, icon, `status: 'built' | 'partial' | 'planned'`, and for non-built
entries the placeholder copy (phase chip, description, CORE.md aims,
exists-today links). The rail, the panel, and every placeholder page render
from this single map.

### Components and pages

- `apps/web/app/(office)/layout.tsx` — becomes the shell (server
  component; rail + panel + top bar + content column).
- `apps/web/app/ui/PlaceholderPage.tsx` — the shared placeholder
  component.
- ~18 placeholder `page.tsx` files (~5 lines each: look up nav entry,
  render `<PlaceholderPage>`).
- `/settings/staff/page.tsx` — the one new real page: read-only roster
  (display name · role · active) from a new query in
  `apps/web/lib/queries.ts`, with the `db:user` CLI instructions printed
  beneath. **No edit form** — ADR 0005's "an admin screen is a login page
  nobody guards" made visible rather than violated. No emails, no
  sensitive columns.
- Existing pages (home/search, customer record, new customer, day board):
  token reskin + targeted markup retouch only (card grid, board columns,
  table density). Forms and all security-sensitive markup untouched.

## Role behavior

Navigation is identical for every signed-in office user. Reads stay open
(ADR 0010); action-level gating (dispatch controls hidden from techs)
continues to live in pages, not nav. The `planned` chips show for
everyone.

## Verification

1. `npm run typecheck`; both existing smoke suites still green — nothing
   they test changes. (Single-writer discipline: dev server stopped for
   suite runs; suites need the `PGLITE_DIR` prefix per STATE.md.)
2. **New `apps/web/scripts/smoke-nav.ts`**: signs in (same fixture
   approach as `smoke-tech-api.ts`), walks every href in `nav.ts`, asserts
   200 and the page's own title in the HTML. A broken placeholder route
   cannot hide.
3. **New contrast check** (`apps/web/scripts/check-contrast.ts` or part of
   smoke-nav): computes WCAG ratios for every declared text-bearing token
   pair in `office.css` and fails below 4.5:1.
4. Browser click-through with screenshots at the end (controller), per the
   session's established pattern.

## Risks and open items

- **Logo asset**: not yet provided; the rail ships with the existing
  green-circle placeholder mark until the real file lands (drop it in
  `apps/web/public/` any time; swapping is one file + one line).
- **`#f7f8fa`-on-white borders** can go invisible on cheap panels — border
  tokens get a real grey, not a whisper.
- **Global search form**: GET to `/` must not break the home page's
  keyboard behavior; the top-bar input is an entry point, not a second
  implementation.
- The repo's **no-third-party-hosts rule** holds: system font stack, no
  CDN icons — icons are inline SVG or unicode, bundled.

## Process notes for the implementation plan

Repo conventions bind: builders don't push unreviewed (`repo-reviewer` +
`sensitive-data-guard` if any sensitive surface is grazed — this effort
should not graze any); commits carry the standard trailers; an applied
migration is immutable (no migrations expected in this effort); PGlite is
single-writer. DEMO.md gains a line about the new shell when the work
lands (docs truth-up task), and `session-scribe` CLOSE records the
session.
