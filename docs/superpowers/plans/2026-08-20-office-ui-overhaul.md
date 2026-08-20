# Office UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the office app an Apollo-style shell — icon rail + section
panel + top bar — with light brand theming and navigation covering every
CORE.md area, unbuilt ones as honest placeholder pages.

**Architecture:** Navigation lives as data in one typed map (`lib/nav.ts`)
that feeds the rail, the panel, and every placeholder page. Theming works by
scoping brand-valued, WCAG-AA-safe overrides of the *existing* token names
(`--accent`, `--danger`, …) under a new `.office` wrapper class in a new
stylesheet — existing office markup re-skins automatically, and the
technician PWA (which has no wrapper) keeps its adaptive theme untouched.
`globals.css` is not modified at all.

**Tech Stack:** Next.js 15 App Router (server components; one small
`'use client'` nav component for `usePathname`), plain scoped CSS custom
properties, tsx scripts for verification.

**Spec:** `docs/superpowers/specs/2026-08-20-office-ui-overhaul-design.md`
— the plan argues from it; read both.

## Global Constraints

- Branch: `office-ui`. Working tree contains only this plan's work.
- **`globals.css` and everything under `app/tech/` are untouched.** `git
  diff` must never show them.
- **No third-party hosts**: system font stack, inline SVG icons only.
- Server components by default; `'use client'` only where a hook forces it.
- Every text-bearing color pair ≥ 4.5:1 (WCAG AA), enforced by
  `check-contrast.ts` (Task 6).
- No fake data, charts, or lorem on placeholder pages.
- The write layer, all API routes, `ActionForm`/`Fields` internals, gate-code
  and photo surfaces: untouched.
- PGlite is single-writer: dev server stopped before suites; suites need the
  prefix `PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2`. Never open, repair,
  or delete the corrupt `./.pgdata`.
- Commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016rhqsKmQZC9woJdjzrft1j`
- Nothing is pushed before Task 7's review gate.

---

### Task 1: Navigation as data

**Files:**
- Create: `apps/web/lib/nav.ts`
- Test: `npm run typecheck`

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 3, 4, 6 rely on these exact names):
  `type NavStatus = 'built' | 'partial' | 'planned'`;
  `type PlaceholderCopy = { phase: string; lead: string; aims: string[]; today?: { label: string; href: string }[] }`;
  `type Subsection = { label: string; href: string; status: NavStatus; probe?: string; placeholder?: PlaceholderCopy }`;
  `type Section = { key: string; label: string; icon: string; href: string; probe?: string; subsections?: Subsection[] }`;
  `export const NAV: Section[]`;
  `export function sectionForPath(pathname: string): Section | null`;
  `export function subsectionFor(href: string): { section: Section; sub: Subsection } | null`.

- [ ] **Step 1: Write the file**

```ts
/**
 * The office app's navigation, as data.
 *
 * One tree feeds the icon rail, the section panel, the placeholder pages and
 * the nav smoke test, so the taxonomy the spec approved lives in exactly one
 * place. Every CORE.md area appears here whether it is built or not — the
 * demo shows the whole intended platform, honestly labeled.
 *
 * `status`: 'built' (page works) · 'partial' (data or schema exists, the
 * page is a placeholder that says so) · 'planned' (placeholder only).
 * `probe` is the string smoke-nav.ts asserts in the response HTML; it
 * defaults to the subsection label, which every placeholder page renders.
 */

export type NavStatus = 'built' | 'partial' | 'planned';

export type PlaceholderCopy = {
  /** e.g. "Phase 3 · inventory" — rendered as the page chip. */
  phase: string;
  /** One paragraph, written from CORE.md's own language. */
  lead: string;
  /** The specific CORE.md aims this screen answers. */
  aims: string[];
  /** Where the capability partially exists today. */
  today?: { label: string; href: string }[];
};

export type Subsection = {
  label: string;
  href: string;
  status: NavStatus;
  probe?: string;
  placeholder?: PlaceholderCopy;
};

export type Section = {
  key: string;
  label: string;
  icon: string;
  href: string;
  probe?: string;
  subsections?: Subsection[];
};

export const NAV: Section[] = [
  {
    key: 'home', label: 'Home', icon: 'home', href: '/',
    probe: 'Search name, phone, address',
  },
  {
    key: 'customers', label: 'Customers', icon: 'people', href: '/customers',
    subsections: [
      { label: 'Directory', href: '/customers', status: 'built', probe: 'Search name, phone, address' },
      { label: 'New customer', href: '/customers/new', status: 'built', probe: 'New customer' },
    ],
  },
  {
    key: 'schedule', label: 'Schedule', icon: 'calendar', href: '/schedule',
    subsections: [
      { label: 'Day board', href: '/schedule', status: 'built', probe: 'Show that day' },
      {
        label: 'Live status', href: '/schedule/live', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'Where every truck is right now. The technician app already records a position at each meaningful moment — en route, arrival, photo, completion — so the breadcrumbs exist; this screen will put them on a map of the day.',
          aims: ['Real-time technician status ("No real-time technician GPS or status")', 'Did the tech get there, when, and how long did it take'],
          today: [{ label: 'Position pings land in work_order_ping per job', href: '/schedule' }],
        },
      },
      {
        label: 'Routes', href: '/schedule/routes', status: 'planned',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'Order the day so the truck drives less. Route optimization takes each technician’s stops and sequences them by geography and time windows.',
          aims: ['Route optimization ("No route optimization")'],
          today: [{ label: 'Stops are ordered by hand on the day board', href: '/schedule' }],
        },
      },
    ],
  },
  {
    key: 'service', label: 'Service', icon: 'wrench', href: '/service/calendar',
    subsections: [
      {
        label: 'Calendar', href: '/service/calendar', status: 'planned',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'The service schedule beyond today: upcoming work by week and month, capacity ahead of time, and — once the platform sits on the business’s Google Workspace — two-way sync with Google Calendar.',
          aims: ['Capacity management ahead of the day', 'Google Calendar sync (platform direction)'],
          today: [{ label: 'Today’s work is on the day board', href: '/schedule' }],
        },
      },
      {
        label: 'Jobs', href: '/service/jobs', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'Every work order across every customer, filterable by status, type and technician. The jobs exist — booked, scheduled, completed, cancelled — this list view across customers does not yet.',
          aims: ['Notes technicians can find', 'One place to see all open work'],
          today: [
            { label: 'A customer’s jobs are on their record', href: '/' },
            { label: 'Today’s jobs are on the day board', href: '/schedule' },
          ],
        },
      },
      {
        label: 'Follow-ups', href: '/service/followups', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'The rebooking worklist. When a technician can’t finish, the reason comes back from the phone — "come back Thursday with the part" — and each one is a job somebody must reschedule before the customer calls first.',
          aims: ['Easy for tasks not to fall through the cracks', 'Turn incomplete visits into booked revisits'],
          today: [{ label: 'Unfinished jobs are flagged on the day board', href: '/schedule' }],
        },
      },
      {
        label: 'Water tests', href: '/service/water', status: 'partial',
        placeholder: {
          phase: 'Phase 1 · customer & timeline',
          lead: 'Recent water tests across all customers — out-of-range results first, so the callbacks happen before the green pool does. Tests are recorded per customer today; the cross-customer view is not built.',
          aims: ['Water testing out of the communication scatter and into the timeline'],
          today: [{ label: 'Record and read tests on a customer’s record', href: '/' }],
        },
      },
      {
        label: 'Checklist templates', href: '/service/templates', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'What each kind of visit always covers. The templates exist in code and seed every job’s checklist; editing them will move here so a new procedure doesn’t need a developer.',
          aims: ['Consistent service steps for a tech hired in March, by April'],
          today: [{ label: 'Templates seed every new job’s checklist automatically', href: '/schedule' }],
        },
      },
    ],
  },
  {
    key: 'inventory', label: 'Inventory', icon: 'box', href: '/inventory/items',
    subsections: [
      {
        label: 'Items', href: '/inventory/items', status: 'partial',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'The item master: barcode-first lookup, internal notes ("these steps need a mat underneath"), easy SKU changes. The schema and counter search are built in the data layer; this screen is next.',
          aims: ['Barcode-first', 'Easy bulk edits', 'Internal product notes', 'SKUs that can change'],
        },
      },
      {
        label: 'Stock levels', href: '/inventory/stock', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Real-time stock, so "do we have one" is answered from the counter, not the warehouse walk.',
          aims: ['Real-time inventory', 'Reorder points that maintain themselves'],
        },
      },
      {
        label: 'Large items', href: '/inventory/large-items', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Big-ticket visibility: which spas, by model and color, are in stock right now — the question CORE.md calls out by name.',
          aims: ['Know which large-ticket items are in stock (e.g. spas by model/color)'],
        },
      },
      {
        label: 'Transfers', href: '/inventory/transfers', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Store-to-truck and back, without confusing the invoicing — the transfer pain CORE.md names.',
          aims: ['Inventory transfers between store and truck that don’t break invoicing'],
        },
      },
      {
        label: 'Channels', href: '/inventory/channels', status: 'partial',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Where items are listed and sold beyond the counter. The channel seam — listing an item, pushing availability, pulling orders — exists in the data layer against a test double; this screen arrives with the first real channel.',
          aims: ['One item master feeding every sales channel'],
        },
      },
    ],
  },
  {
    key: 'purchasing', label: 'Purchasing', icon: 'cart', href: '/purchasing/orders',
    subsections: [
      {
        label: 'Purchase orders', href: '/purchasing/orders', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Ordering across vendors in one flow instead of one vendor portal at a time.',
          aims: ['Efficiently purchase across multiple vendors', 'Replace the manual ordering process'],
        },
      },
      {
        label: 'Vendors', href: '/purchasing/vendors', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'Vendors, terms, and catalogs — the other half of multi-vendor purchasing and reporting.',
          aims: ['Purchase and report across multiple vendors'],
        },
      },
      {
        label: 'Reorder suggestions', href: '/purchasing/reorder', status: 'planned',
        placeholder: {
          phase: 'Phase 3 · inventory',
          lead: 'The intelligent half: what to order before it runs out, informed by season — pool opening chemicals in March, stove pellets in September.',
          aims: ['Intelligent purchasing recommendations', 'Automated reorder suggestions', 'Seasonal forecasting'],
        },
      },
    ],
  },
  {
    key: 'sales', label: 'Sales & POS', icon: 'dollar', href: '/sales/quotes',
    subsections: [
      {
        label: 'Quotes', href: '/sales/quotes', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · POS & payments (cuts over January–March)',
          lead: 'Quotes a customer can actually read — the "quotes are confusing" fix.',
          aims: ['Cleaner customer-facing quotes'],
        },
      },
      {
        label: 'Orders', href: '/sales/orders', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · POS & payments (cuts over January–March)',
          lead: 'Sales orders and service orders flowing into the register without re-keying — the SO-to-POS gap.',
          aims: ['Move smoothly from Sales/Service Order to POS'],
        },
      },
      {
        label: 'Register', href: '/sales/register', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · POS & payments (cuts over January–March)',
          lead: 'The counter register. Built last on purpose: highest risk, most regulated, and it benefits most from a domain model proven in daily use. Offline-capable before cutover — a cable outage in June must not close the store.',
          aims: ['Excellent POS', 'Combined payments'],
        },
      },
      {
        label: 'Payments', href: '/sales/payments', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · POS & payments (cuts over January–March)',
          lead: 'One payment across orders and invoices, and card surcharges where permitted.',
          aims: ['Combine payments easily', 'Automatic credit-card processing fees (where permitted)'],
        },
      },
    ],
  },
  {
    key: 'reports', label: 'Reports', icon: 'chart', href: '/reports/dashboards',
    subsections: [
      {
        label: 'Dashboards', href: '/reports/dashboards', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · AI & reporting',
          lead: 'Executive dashboards over the one customer record: revenue by season, service load, what’s selling.',
          aims: ['Executive dashboards'],
        },
      },
      {
        label: 'Forecasting', href: '/reports/forecasting', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · AI & reporting',
          lead: 'Seasonal forecasting for a business with two seasons: pools April–September, stoves September–December.',
          aims: ['Inventory forecasting', 'Seasonal purchasing signals'],
        },
      },
      {
        label: 'Ask', href: '/reports/ask', status: 'planned',
        placeholder: {
          phase: 'Phase 4 · AI & reporting',
          lead: 'Ask in plain language — "which pool customers haven’t booked an opening yet?" AI features read from filtered views, never the raw tables, so a summary can never swallow a gate code (ADR 0003).',
          aims: ['Natural-language search', 'Customer/property summaries', 'Suggested upsells'],
        },
      },
    ],
  },
  {
    key: 'settings', label: 'Settings', icon: 'gear', href: '/settings/staff',
    subsections: [
      { label: 'Staff', href: '/settings/staff', status: 'built', probe: 'Staff' },
      {
        label: 'Integrations', href: '/settings/integrations', status: 'planned',
        placeholder: {
          phase: 'Platform direction',
          lead: 'The platform sits on top of the business’s Google Workspace: schedules sync with Google Calendar, Gmail feeds each customer’s timeline, and Google accounts eventually handle sign-in. Alongside it: Podium (texts), QuickBooks (accounting), and the fleet tracker.',
          aims: ['Google Workspace: Calendar sync, Gmail into the timeline, Google sign-in (future)', 'Podium texts on the customer timeline', 'QuickBooks events on the timeline', 'Fleet tracking for live truck location'],
        },
      },
    ],
  },
];

/** The section a path belongs to, longest prefix wins ('/' only matches exactly). */
export function sectionForPath(pathname: string): Section | null {
  if (pathname === '/') return NAV[0]!;
  let best: Section | null = null;
  let bestLen = 0;
  for (const s of NAV) {
    const prefixes = [s.href, ...(s.subsections?.map((x) => x.href) ?? [])];
    for (const p of prefixes) {
      if (p !== '/' && (pathname === p || pathname.startsWith(p + '/')) && p.length > bestLen) {
        best = s; bestLen = p.length;
      }
    }
  }
  // Customer record pages live under /customers/<id>.
  if (!best && pathname.startsWith('/customers')) {
    return NAV.find((s) => s.key === 'customers') ?? null;
  }
  return best;
}

/** Find a subsection by exact href — how placeholder pages get their copy. */
export function subsectionFor(href: string): { section: Section; sub: Subsection } | null {
  for (const section of NAV) {
    for (const sub of section.subsections ?? []) {
      if (sub.href === href) return { section, sub };
    }
  }
  return null;
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` — expected clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/nav.ts
git commit -m "The whole platform's map, as one data structure"
```

---

### Task 2: The brand token layer and shell stylesheet

**Files:**
- Create: `apps/web/app/office.css`
- Modify: `apps/web/app/login/page.tsx` (two lines: import + wrapper class)
- Test: `npm run typecheck`; `git diff --stat` shows neither `globals.css` nor anything under `app/tech/`

**Interfaces:**
- Consumes: the class names existing office markup already uses (`.card`,
  `.badge`, `.flag`, `.load`, `.field`, `button.primary`, …) — they resolve
  the same token *names*, now brand-valued inside `.office`.
- Produces: the `.office` wrapper class; shell classes `.o-frame`, `.o-rail`,
  `.o-panel`, `.o-topbar`, `.o-main`, `.o-search`; page classes `.pagehead`,
  `.chip`, `.chip.planned`, `.ph`, `.ph-aims`, `.ph-status`, `.ph-today`,
  `.roster`. Tokens listed below. Tasks 3-5 use these exact names.

- [ ] **Step 1: Write `apps/web/app/office.css`**

The mechanism: `.office` re-declares the token names `globals.css` already
uses, with brand-derived AA-safe values, so every existing office class
re-skins automatically; element-scoped custom properties beat the
`:root`-level dark media query, so the office is light even on a dark OS,
and the PWA (no `.office` anywhere) is untouched. Raw brand hues get
`-raw` tokens for contrast-ungated uses.

```css
/*
 * The office shell and its brand-light theme. Imported by the (office)
 * layout and the login page only — never by /tech.
 *
 * Token names deliberately shadow globals.css inside .office: existing
 * office markup (cards, badges, flags, forms) re-skins without edits, and
 * scoping on a class beats the :root dark-mode media query, so the office
 * is light regardless of OS theme. Raw brand hues (#0092db, #f56b49,
 * #fbcc28, #3db54e) live in -raw tokens for fills and identity moments;
 * every token that carries text is a derived step checked ≥ 4.5:1 by
 * scripts/check-contrast.ts. Change a value here, run that script.
 */

.office {
  /* Champlain Pools & Spa brand, AA-derived. */
  --bg: #f6f8fa;
  --surface: #ffffff;
  --surface-2: #eef1f4;
  --border: #d5dbe2;
  --text: #3e4348;            /* dim-grey #4d4d4d deepened a step for body */
  --text-strong: #1f2428;
  --text-dim: #5b6470;        /* 6.0:1 on white */
  --accent: #0074af;          /* dodger-blue text/border-safe step, 5.1:1 */
  --accent-raw: #0092db;      /* the brand blue itself — fills, icons */
  --accent-soft: #e5f4fc;
  --warn: #8a5a00;            /* gold's text-safe step */
  --warn-raw: #fbcc28;
  --warn-soft: #fdf6dc;       /* gold-tinted chip background */
  --danger: #b83a1b;          /* tomato's text-safe step: 5.7:1 on white, 4.9:1 on --danger-soft */
  --danger-raw: #f56b49;
  --danger-soft: #fdeae4;
  --ok: #277933;              /* sea-green's text-safe step, 5.4:1 */
  --ok-raw: #3db54e;
  --ok-soft: #e7f6ea;
  --radius: 10px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 4px 12px rgba(16, 24, 40, .05);

  background: var(--bg);
  color: var(--text);
}

/* ── the frame: rail · panel · content ─────────────────────────────── */

/* Flex, not grid: the panel is conditionally rendered (Home has no
   subsections), and a missing middle child must not strand a grid column. */
.o-frame {
  display: flex;
  min-height: 100vh;
}
.o-rail, .o-panel { flex: none; }
.o-body { flex: 1; min-width: 0; }

.o-rail {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center;
  padding: 10px 0; gap: 2px;
  position: sticky; top: 0; height: 100vh;
}
.o-logo {
  width: 36px; height: 36px; border-radius: 9px;
  background: var(--accent-raw);
  color: #fff; font-weight: 700; font-size: 15px;
  display: grid; place-items: center;
  margin-bottom: 10px;
}
.o-rail a.o-item {
  width: 56px; padding: 7px 0 5px; border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  color: var(--text-dim); font-size: 10px; line-height: 1.2;
  text-align: center;
}
.o-rail a.o-item svg { width: 20px; height: 20px; }
.o-rail a.o-item:hover { background: var(--surface-2); color: var(--text-strong); }
.o-rail a.o-item[data-active="true"] {
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
}
.o-rail .o-spacer { flex: 1; }
.o-rail .o-sep {
  width: 40px; border-top: 1px solid var(--border); margin: 8px 0;
}

.o-panel {
  width: 200px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 16px 10px;
  position: sticky; top: 0; height: 100vh;
}
.o-panel h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--text-dim); margin: 0 6px 10px; font-weight: 600;
}
.o-panel a {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; border-radius: 7px;
  font-size: 14px; color: var(--text);
}
.o-panel a:hover { background: var(--surface-2); }
.o-panel a[data-active="true"] {
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
  box-shadow: inset 3px 0 0 var(--accent-raw);
}

/* The panel element is only rendered when the section has subsections
   (OfficeNav returns null for it otherwise) — no :empty tricks. */

/* ── top bar and content ───────────────────────────────────────────── */

.o-body { display: flex; flex-direction: column; min-width: 0; }

.o-topbar {
  height: 52px; flex: none;
  display: flex; align-items: center; gap: 14px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 5;
}
.o-search { flex: 0 1 420px; display: flex; }
.o-search input {
  width: 100%; font: inherit; font-size: 14px;
  padding: 7px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
}
.o-search input:focus { outline: none; border-color: var(--accent); background: var(--surface); }

.o-main { padding: 22px 24px 80px; max-width: 1120px; width: 100%; }

.pagehead { margin-bottom: 20px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.pagehead h2 { margin: 0; font-size: 24px; letter-spacing: -.01em; color: var(--text-strong); }

.chip {
  font-size: 12px; padding: 3px 10px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim);
}
.chip.planned { background: var(--warn-soft); border-color: var(--warn-raw); color: var(--warn); }

/* Small planned marker inside the nav panel. */
.o-panel .chip { font-size: 10px; padding: 1px 7px; }

/* ── placeholder pages ─────────────────────────────────────────────── */

.ph { max-width: 640px; }
.ph .lead { font-size: 16px; line-height: 1.6; }
.ph-aims { margin: 14px 0 0; padding-left: 20px; }
.ph-aims li { margin-bottom: 6px; }
.ph-status {
  margin-top: 18px; font-size: 13px; color: var(--text-dim);
  padding-top: 12px; border-top: 1px solid var(--border);
}
.ph-today { margin-top: 8px; font-size: 14px; }
.ph-today a { color: var(--accent); text-decoration: underline; }

/* ── staff roster ──────────────────────────────────────────────────── */

.roster { border-collapse: collapse; width: 100%; font-size: 15px; }
.roster th {
  text-align: left; font-size: 11px; text-transform: uppercase;
  letter-spacing: .05em; color: var(--text-dim); font-weight: 600;
  padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border);
}
.roster td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--border); }

/* ── brand accents on existing elements ────────────────────────────── */

.office .search:focus { border-color: var(--accent-raw); }
.office .result:hover, .office .result[data-active="true"] {
  border-color: var(--accent-raw);
}
.office button.primary {
  background: var(--accent); border-color: var(--accent);
}
.office button.primary:hover:not(:disabled) { background: #00629a; border-color: #00629a; }
.office .badge.accent { color: var(--accent); }
.office .load.over { color: var(--danger); }

/* Narrow windows: the panel collapses; the office is a desktop surface. */
@media (max-width: 900px) {
  .o-frame { grid-template-columns: 64px 1fr; }
  .o-panel { display: none; }
}
```

- [ ] **Step 2: Give the login page the light treatment**

In `apps/web/app/login/page.tsx`, add at the top:

```ts
import '../office.css';
```

and change the container line from
`<div className="loginwrap">` to
`<div className="office loginwrap" style={{ minHeight: '100vh' }}>` —
the wrapper class alone flips the sign-in card to brand-light on any OS
theme. (`loginwrap`'s own layout styles still come from globals.)

- [ ] **Step 3: Verify scope safety**

Run: `npm run typecheck` — clean.
Run: `git diff --stat` — must list only `apps/web/app/office.css` and
`apps/web/app/login/page.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/office.css apps/web/app/login/page.tsx
git commit -m "Brand tokens, scoped: the office goes Champlain light and the PWA cannot tell"
```

---

### Task 3: The shell — rail, panel, top bar

**Files:**
- Create: `apps/web/app/ui/OfficeNav.tsx`
- Modify: `apps/web/app/(office)/layout.tsx` (full rewrite, 42 lines today)
- Modify: `apps/web/app/(office)/CustomerSearch.tsx` (accept `initialQuery`)
- Modify: `apps/web/app/(office)/page.tsx` (pass `searchParams.q` through)
- Test: `npm run typecheck` + manual render check (Step 5)

**Interfaces:**
- Consumes: `NAV`, `sectionForPath`, types from `apps/web/lib/nav.ts`
  (Task 1); classes from `office.css` (Task 2); existing `getSessionUser`,
  `signOutAction`.
- Produces: `OfficeNav` client component (`{ sections: Section[] }` props);
  the layout contract every page renders inside: `.office.o-frame > o-rail +
  o-panel + .o-body > (.o-topbar + .o-main)`. `CustomerSearch` gains
  optional `initialQuery?: string`.

- [ ] **Step 1: Write `apps/web/app/ui/OfficeNav.tsx`**

Client component — `usePathname` decides active states; also owns the `/`
keyboard shortcut for the top-bar search.

```tsx
'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { NAV, sectionForPath, type Section } from '@/lib/nav';

/**
 * The icon rail and section panel. Client-side only because active-state
 * needs usePathname; everything it renders comes from the NAV data.
 * Icons are inline SVG — nothing loads from a third-party host.
 */

const ICONS: Record<string, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.6a3.2 3.2 0 1 1 0 4.9M16.2 14.3c2 .5 3.4 2.1 3.9 4.7" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  wrench: <path d="M14.7 6.5a4.2 4.2 0 0 0 5.6-5l-3 3-2.8-.8-.8-2.8 3-3a4.2 4.2 0 0 0-5 5.6L4 11.2a2.3 2.3 0 1 0 3.2 3.2l7.5-7.9Z" transform="translate(1.5 4.5)" />,
  box: <><path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2V8.2Z" /><path d="M4 8.2 12 12l8-3.8M12 12v8" /></>,
  cart: <><circle cx="9.5" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /><path d="M3.5 4.5h2.5l2.2 10.5h9.6l2.2-8H7" /></>,
  dollar: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.7 9.2c-.6-1-1.6-1.4-2.7-1.4-1.4 0-2.5.7-2.5 1.9 0 2.7 5.4 1.3 5.4 4 0 1.3-1.2 2-2.9 2-1.2 0-2.3-.5-2.9-1.5" /></>,
  chart: <path d="M4.5 19.5v-6.5M10 19.5V8M15.5 19.5v-9.5M21 19.5V4.5M3 19.5h18.5" />,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M18 6l-1.7 1.7M7.7 16.3 6 18M18 18l-1.7-1.7M7.7 7.7 6 6" /></>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.2" /><path d="M10.5 18.5h3" /></>,
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

export default function OfficeNav({ sections }: { sections: Section[] }) {
  const pathname = usePathname();
  const active = sectionForPath(pathname);

  // "/" focuses the global search from anywhere, unless typing already.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const main = sections.filter((s) => s.key !== 'settings');
  const settings = sections.find((s) => s.key === 'settings');

  return (
    <>
      <nav className="o-rail" aria-label="Sections">
        <div className="o-logo" title="Lake Champlain Pools, Spas & Stoves">C</div>
        {main.map((s) => (
          <a key={s.key} href={s.href} className="o-item"
            data-active={active?.key === s.key ? 'true' : undefined}>
            <Icon name={s.icon} />{s.label}
          </a>
        ))}
        <div className="o-spacer" />
        {settings && (
          <a href={settings.href} className="o-item"
            data-active={active?.key === 'settings' ? 'true' : undefined}>
            <Icon name={settings.icon} />{settings.label}
          </a>
        )}
        <div className="o-sep" />
        <a href="/tech" className="o-item" title="Opens the technician app">
          <Icon name="phone" />Tech app
        </a>
      </nav>

      {active?.subsections?.length ? (
        <nav className="o-panel" aria-label="Section pages">
          <>
            <h2>{active.label}</h2>
            {active.subsections.map((sub) => (
              <a key={sub.href} href={sub.href}
                data-active={
                  (pathname === sub.href
                    || (sub.href !== '/' && pathname.startsWith(sub.href + '/'))
                    || (sub.href === '/customers' && pathname.startsWith('/customers/') && !pathname.startsWith('/customers/new')))
                    ? 'true' : undefined
                }>
                {sub.label}
                {sub.status !== 'built' && <span className="chip planned">planned</span>}
              </a>
            ))}
          </>
        </nav>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Rewrite `apps/web/app/(office)/layout.tsx`**

```tsx
import '../office.css';
import OfficeNav from '../ui/OfficeNav';
import { NAV } from '@/lib/nav';
import { getSessionUser } from '@/lib/session';
import { signOutAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The office shell: icon rail, section panel, top bar, content.
 *
 * Who is signed in stays visible at all times — this is a shared machine
 * behind a counter and people walk away from it mid-task; every note saved
 * from here carries that name permanently, so the name lives in the top
 * bar, never behind a menu. (Unchanged rule from the previous shell.)
 *
 * The top-bar search is an entry point, not a second implementation: a
 * plain GET to "/", where CustomerSearch picks the query up. "/" focuses
 * it from anywhere (OfficeNav owns the key handler).
 */
export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <div className="office o-frame">
      <OfficeNav sections={NAV} />
      <div className="o-body">
        <div className="o-topbar">
          <form className="o-search" action="/" method="get">
            <input id="global-search" type="search" name="q"
              placeholder="Search customers…  ( / )" aria-label="Search customers" />
          </form>
          <div className="who-bar">
            {user && (
              <>
                <span className="whoami" title={user.email}>
                  {user.label}
                  {user.role !== 'staff' && <span className="badge">{user.role}</span>}
                </span>
                <form action={signOutAction}>
                  <button type="submit" className="linkish">Sign out</button>
                </form>
              </>
            )}
          </div>
        </div>
        <main className="o-main">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Teach `CustomerSearch` an initial query**

In `apps/web/app/(office)/CustomerSearch.tsx`:
change the signature line
`export default function CustomerSearch() {` to

```tsx
export default function CustomerSearch({ initialQuery = '' }: { initialQuery?: string } = {}) {
```

and the state line `const [q, setQ] = useState('');` to

```tsx
const [q, setQ] = useState(initialQuery);
```

(The existing debounce effect fires on mount when `q` is non-empty, so a
top-bar search lands on `/` with results already loading. No other edits.)

- [ ] **Step 4: Pass the query through on the home page**

In `apps/web/app/(office)/page.tsx`, change the component signature to:

```tsx
export default async function Home({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;
```

and the render line `<CustomerSearch />` to
`<CustomerSearch initialQuery={q ?? ''} />`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — clean.
Then start the dev server
(`PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2 npm run dev -w @lcp/web`),
sign-in state is not needed for this check: GET `/login` and confirm the
HTML contains `class="office loginwrap"`. With a minted session (same
approach as `smoke-tech-api.ts`), GET `/` and confirm the response contains
`o-rail`, `o-topbar`, and `global-search`. GET `/schedule` and confirm
`o-panel` contains `Day board`. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/ui/OfficeNav.tsx "apps/web/app/(office)/layout.tsx" \
  "apps/web/app/(office)/CustomerSearch.tsx" "apps/web/app/(office)/page.tsx"
git commit -m "An Apollo-shaped shell: rail, section panel, and a search that follows you"
```

---

### Task 4: Placeholder pages, the directory, and the staff roster

**Files:**
- Create: `apps/web/app/ui/PlaceholderPage.tsx`
- Create: 18 placeholder pages (exact list in Step 2)
- Create: `apps/web/app/(office)/customers/page.tsx`
- Create: `apps/web/app/(office)/settings/staff/page.tsx`
- Modify: `apps/web/lib/queries.ts` (add `listStaff`)
- Test: `npm run typecheck`; full route walk arrives in Task 6

**Interfaces:**
- Consumes: `subsectionFor` from `lib/nav.ts`; `.ph*`, `.pagehead`, `.chip`,
  `.roster` classes; `requireUser`; `CustomerSearch` with `initialQuery`.
- Produces: `PlaceholderPage({ href }: { href: string })`;
  `listStaff(): Promise<StaffRow[]>` where
  `type StaffRow = { display_name: string; role: string; active: boolean }`.

- [ ] **Step 1: Write `apps/web/app/ui/PlaceholderPage.tsx`**

```tsx
import { subsectionFor } from '@/lib/nav';

const STATUS_LINE = {
  partial: 'Begun in code — the data layer exists; this screen does not yet. See DEMO.md for exact status.',
  planned: 'Not started. This page marks the intended destination. See DEMO.md for the roadmap.',
  built: '',
} as const;

/**
 * What an unbuilt destination shows: the aim, in CORE.md's own language,
 * and an honest status. Deliberately no fake data and no mock charts — a
 * placeholder that looks like a working dashboard would lie, and this
 * repository's whole documentation culture is honest status.
 */
export default function PlaceholderPage({ href }: { href: string }) {
  const found = subsectionFor(href);
  if (!found?.sub.placeholder) {
    throw new Error(`No placeholder copy in nav.ts for ${href}`);
  }
  const { sub } = found;
  const copy = sub.placeholder!;

  return (
    <div className="ph">
      <div className="pagehead">
        <h2>{sub.label}</h2>
        <span className="chip planned">{copy.phase}</span>
      </div>
      <p className="lead">{copy.lead}</p>
      <ul className="ph-aims">
        {copy.aims.map((aim) => <li key={aim}>{aim}</li>)}
      </ul>
      <p className="ph-status">{STATUS_LINE[sub.status]}</p>
      {copy.today?.length ? (
        <p className="ph-today">
          Today: {copy.today.map((t, i) => (
            <span key={t.href}>{i > 0 && ' · '}<a href={t.href}>{t.label}</a></span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Create the 18 placeholder routes**

Every file has exactly this shape (shown for the first; repeat with the
matching `href` for each). `requireUser()` keeps the whole office behind a
session, placeholders included.

```tsx
// apps/web/app/(office)/schedule/live/page.tsx
import PlaceholderPage from '../../../ui/PlaceholderPage';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireUser();
  return <PlaceholderPage href="/schedule/live" />;
}
```

The full list — path → `href` argument (watch the `../` depth: routes two
segments deep use `'../../../ui/PlaceholderPage'`):

| File under `apps/web/app/(office)/` | href |
|---|---|
| `schedule/live/page.tsx` | `/schedule/live` |
| `schedule/routes/page.tsx` | `/schedule/routes` |
| `service/calendar/page.tsx` | `/service/calendar` |
| `service/jobs/page.tsx` | `/service/jobs` |
| `service/followups/page.tsx` | `/service/followups` |
| `service/water/page.tsx` | `/service/water` |
| `service/templates/page.tsx` | `/service/templates` |
| `inventory/items/page.tsx` | `/inventory/items` |
| `inventory/stock/page.tsx` | `/inventory/stock` |
| `inventory/large-items/page.tsx` | `/inventory/large-items` |
| `inventory/transfers/page.tsx` | `/inventory/transfers` |
| `inventory/channels/page.tsx` | `/inventory/channels` |
| `purchasing/orders/page.tsx` | `/purchasing/orders` |
| `purchasing/vendors/page.tsx` | `/purchasing/vendors` |
| `purchasing/reorder/page.tsx` | `/purchasing/reorder` |
| `sales/quotes/page.tsx` | `/sales/quotes` |
| `sales/orders/page.tsx` | `/sales/orders` |
| `sales/register/page.tsx` | `/sales/register` |
| `sales/payments/page.tsx` | `/sales/payments` |
| `reports/dashboards/page.tsx` | `/reports/dashboards` |
| `reports/forecasting/page.tsx` | `/reports/forecasting` |
| `reports/ask/page.tsx` | `/reports/ask` |
| `settings/integrations/page.tsx` | `/settings/integrations` |

(23 files — "18 placeholders" in the spec counted before Live status,
Routes and the split of Reports; the nav map is the authority. Every
`href` above must have a `placeholder` entry in `nav.ts` — Task 1 provides
all of them.)

- [ ] **Step 3: The customers directory**

`apps/web/app/(office)/customers/page.tsx` — same search, its own route,
so the Customers section can be active:

```tsx
import CustomerSearch from '../CustomerSearch';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function CustomersDirectory({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;
  return (
    <>
      <div className="pagehead"><h2>Directory</h2></div>
      <CustomerSearch initialQuery={q ?? ''} />
      <p className="hint">
        Not on file? <a className="linkish" href="/customers/new">Add a customer</a>
      </p>
    </>
  );
}
```

- [ ] **Step 4: The staff roster**

Add to `apps/web/lib/queries.ts` (near `getTechnicians`, which shows the
house style):

```ts
export type StaffRow = {
  display_name: string;
  role: string;
  active: boolean;
};

/**
 * The roster for /settings/staff. Names, roles, active flags — nothing
 * else. No emails and no auth columns: this page is read-only on purpose
 * (ADR 0005: an admin screen is a login page nobody guards), so it gets
 * only what a person needs to see who works here.
 */
export async function listStaff(): Promise<StaffRow[]> {
  const { db } = await getDb();
  return rows<StaffRow>(await db.execute(sql`
    SELECT display_name, role, active
      FROM app_user
     ORDER BY active DESC, (role <> 'tech'), display_name
  `));
}
```

`apps/web/app/(office)/settings/staff/page.tsx`:

```tsx
import { listStaff } from '@/lib/queries';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Read-only by design. ADR 0005: accounts are managed from the command
 * line because an admin screen is a login page nobody guards, on the
 * machine that holds every customer's gate code. This page shows the
 * roster and prints the commands — the rule made visible, not violated.
 */
export default async function StaffPage() {
  await requireUser();
  const staff = await listStaff();

  return (
    <>
      <div className="pagehead"><h2>Staff</h2></div>
      <div className="card">
        <table className="roster">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Status</th></tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.display_name}>
                <td>{s.display_name}</td>
                <td><span className="badge">{s.role}</span></td>
                <td>{s.active ? 'active' : <span className="badge bad">deactivated</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Managing accounts</h3>
        <p style={{ marginTop: 0 }}>
          There is deliberately no edit form here (ADR 0005). Accounts are
          managed from the repository:
        </p>
        <pre className="cmd">{`npm run db:user -- add --email you@example.com --name "Your Name" --role staff
npm run db:user -- pin --email you@example.com
npm run db:user -- deactivate --email you@example.com`}</pre>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck` — clean.

```bash
git add apps/web/app/ui/PlaceholderPage.tsx "apps/web/app/(office)" apps/web/lib/queries.ts
git commit -m "Every CORE.md destination exists: honest placeholders, a directory, a read-only roster"
```

---

### Task 5: Retouch the existing pages

**Files:**
- Modify: `apps/web/app/(office)/page.tsx` (page header)
- Modify: `apps/web/app/(office)/schedule/page.tsx` (header block only)
- Modify: `apps/web/app/(office)/customers/[id]/page.tsx` (back-link only)
- Modify: `apps/web/app/(office)/customers/new/page.tsx` (page header)
- Test: `npm run typecheck` + render check in Task 6's walk

The token shadowing did the heavy lifting; what remains is aligning page
headers with the new `.pagehead` idiom and removing chrome the shell made
redundant. **Nothing else in these files changes** — forms, GateCode,
timeline, board rows all stay byte-identical.

- [ ] **Step 1: Home** — in `(office)/page.tsx`, wrap the existing content
  with a header so the landing reads as a page, replacing nothing else:
  immediately before `<CustomerSearch …/>` add:

```tsx
      <div className="pagehead">
        <h2>Find a customer</h2>
      </div>
```

- [ ] **Step 2: Schedule** — in `schedule/page.tsx`, the old
  `<a className="back" href="/">← Search</a>` line (the shell's nav now
  does this job): delete it. Change `<div className="header">` block's
  `<h2>{fmtDay(date)}</h2>` to stay as-is — only the back-link goes.

- [ ] **Step 3: Customer record** — in `customers/[id]/page.tsx`, the
  `<a className="back" href="/">← Search</a>` at the top: change to
  `<a className="back" href="/customers">← Directory</a>` (the section it
  now lives under).

- [ ] **Step 4: New customer** — in `customers/new/page.tsx`, find its
  back-link `<a className="back" href="/">← Search</a>` (if present) and
  change the href to `/customers` likewise; leave everything else.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck` — clean.
Run: `git diff --stat` — exactly the four page files.

```bash
git add "apps/web/app/(office)"
git commit -m "The pages settle into the shell"
```

---

### Task 6: The nav walk and the contrast gate

**Files:**
- Create: `apps/web/scripts/smoke-nav.ts`
- Create: `apps/web/scripts/check-contrast.ts`
- Test: both scripts run green (this task IS the test cycle)

**Interfaces:**
- Consumes: `NAV` (hrefs, statuses, probes) from `lib/nav.ts`; the office
  token block in `office.css`; `createDb`/`signIn`/`SESSION_COOKIE` from
  `@lcp/db` (same fixture approach as `smoke-tech-api.ts`).
- Produces: the two commands Task 7's gate cites.

- [ ] **Step 1: Write `apps/web/scripts/check-contrast.ts`**

```ts
/**
 * The spec's contrast rule, enforced: every text-bearing token pair in
 * office.css ships at >= 4.5:1 (WCAG AA). Parses the .office token block
 * and checks the declared pairs below. Change a token, run this.
 *
 *   npx tsx apps/web/scripts/check-contrast.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../app/office.css'), 'utf8');

const tokens = new Map<string, string>();
for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  if (!tokens.has(m[1]!)) tokens.set(m[1]!, m[2]!.toLowerCase());
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}
const val = (name: string): string => {
  if (name.startsWith('#')) return name.toLowerCase();
  const v = tokens.get(name);
  if (!v) { console.log(`FAIL  token ${name} not found in office.css`); process.exit(1); }
  return v;
};

// Every pair that carries text. Update alongside office.css.
const PAIRS: [fg: string, bg: string, where: string][] = [
  ['--text', '--surface', 'body text on cards'],
  ['--text', '--bg', 'body text on canvas'],
  ['--text-strong', '--surface', 'headings'],
  ['--text-dim', '--surface', 'secondary text on cards'],
  ['--text-dim', '--bg', 'secondary text on canvas'],
  ['--text-dim', '--surface-2', 'chips and kbd hints'],
  ['--accent', '--surface', 'links and active nav'],
  ['--accent', '--accent-soft', 'active nav item text'],
  ['#ffffff', '--accent', 'primary button label'],
  ['--ok', '--surface', 'success text'],
  ['--ok', '--ok-soft', 'success chip text'],
  ['--danger', '--surface', 'danger and over-capacity text'],
  ['--danger', '--danger-soft', 'danger chip text'],
  ['--warn', '--surface', 'warning text'],
  ['--warn', '--warn-soft', 'warning chip text (gold tint)'],
];

let failures = 0;
for (const [fg, bg, where] of PAIRS) {
  const r = ratio(val(fg), val(bg));
  const ok = r >= 4.5;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1  ${fg} on ${bg}  (${where})`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} pair(s) under 4.5:1` : '\nAll pairs pass WCAG AA.');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it — expected all PASS.** If any pair fails, darken
  that token in `office.css` until it passes; the brand hue stays in the
  `-raw` token. Record the final output in the commit message's body if
  any value moved.

- [ ] **Step 3: Write `apps/web/scripts/smoke-nav.ts`**

```ts
/**
 * Walks every destination in lib/nav.ts against a running dev server and
 * asserts each one answers 200 with its own content — a broken placeholder
 * route or a nav entry with no page cannot hide.
 *
 * Needs a FRESHLY started dev server (same PGlite page-cache reasoning as
 * smoke-tech-api.ts — sessions minted below must be visible to it):
 *   PGLITE_DIR=$REPO/.pgdata2 npm run dev -w @lcp/web
 *   npx tsx apps/web/scripts/smoke-nav.ts
 */
import { sql } from 'drizzle-orm';
import { createDb, loadRepoEnv, signIn, createUser, setPin, SESSION_COOKIE } from '@lcp/db';
import { NAV } from '../lib/nav.js';

loadRepoEnv();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3100';

{
  const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local || process.env.DATABASE_URL) {
    console.error('Refusing to run outside the local demo database.');
    process.exit(1);
  }
}

const rows = (r: any) => (r?.rows ?? r) as any[];
let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

const NAV_EMAIL = 'nav-smoke@lakechamplainpools.example';
const NAV_PIN = '918273';

const cookie = await (async () => {
  const { db, close } = await createDb();
  try {
    const existing = rows(await db.execute(sql`
      SELECT id FROM app_user WHERE lower(email) = ${NAV_EMAIL}`))[0];
    const id: string = existing?.id
      ?? (await createUser(db, { email: NAV_EMAIL, displayName: 'Nav smoke fixture' })).id;
    await setPin(db, id, NAV_PIN);
    await db.execute(sql`UPDATE app_user SET active = true WHERE id = ${id}::uuid`);
    const r = await signIn(db, { email: NAV_EMAIL, pin: NAV_PIN });
    if (!r.ok) throw new Error(`sign-in failed: ${r.error}`);
    return `${SESSION_COOKIE}=${r.token}`;
  } finally {
    await close();
  }
})();

const targets: { href: string; probe: string }[] = [];
for (const s of NAV) {
  if (!s.subsections?.length) targets.push({ href: s.href, probe: s.probe ?? s.label });
  for (const sub of s.subsections ?? []) {
    targets.push({ href: sub.href, probe: sub.probe ?? sub.label });
  }
}

for (const t of targets) {
  const res = await fetch(`${BASE}${t.href}`, { headers: { cookie }, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  check(`${t.href} answers 200 and shows "${t.probe}"`,
    res.status === 200 && html.includes(t.probe),
    `status ${res.status}`);
  if (res.status === 200) {
    check(`${t.href} renders inside the shell`, html.includes('o-rail'));
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL NAV CHECKS PASSED');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 4: Run the walk**

Database prep if needed (dev server stopped): `npm run etl -- demo`.
Then: `PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2 npm run dev -w @lcp/web`
(fresh), then `npx tsx apps/web/scripts/smoke-nav.ts`.

Expected: every target PASSes (2 checks per destination). Any FAIL names
the broken route — fix and re-run. Stop the server after.

- [ ] **Step 5: Confirm the untouched surfaces**

Run: `npm run typecheck` — clean.
Run: `git diff 86b8f2e..HEAD --stat -- apps/web/app/globals.css apps/web/app/tech packages/db/src/write apps/web/app/api`
Expected: **empty output** — the Global Constraint holds across the
branch's whole history (`86b8f2e` is where `office-ui` forked).

- [ ] **Step 6: Commit**

```bash
git add apps/web/scripts/smoke-nav.ts apps/web/scripts/check-contrast.ts
git commit -m "Two gates for the shell: every destination answers, every pair reads"
```

---

### Task 7: Docs, review gate, ship

- [ ] **Step 1: DEMO.md** — in the "Running the demo" section, after the
  back-office/technician-app sentence, add:

```
The back office presents as an Apollo-style shell — icon rail, per-section
navigation, global search — covering every CORE.md area; unbuilt sections
are honest placeholder pages, not mockups.
```

and in "Feature goals versus what the demo contains", CORE.md
non-negotiables table: no row changes (the shell is chrome, not
capability). Commit:

```bash
git add DEMO.md
git commit -m "DEMO.md notices the shell"
```

- [ ] **Step 2: repo-reviewer** over the whole branch (base `86b8f2e`),
  with the diff packaged for it. Expect attention on: untracked-file
  check for the ~28 new files (`git ls-files` vs imports), the
  `sectionForPath` prefix logic, stale comments.
- [ ] **Step 3: sensitive-data-guard** — the shell touches no sensitive
  surface, but the customer page edit and the roster page graze its
  territory (roster must carry no emails/auth columns; no gate-code
  markup moved). Cheap insurance, run it.
- [ ] **Step 4: Fix or consciously accept findings; controller browser
  pass with screenshots** (sign in, walk the rail, open a placeholder,
  check the login page, compare `/tech` — must look exactly as before).
- [ ] **Step 5: Mark and push**

```bash
node tools/review-gate/mark-reviewed.mjs repo-reviewer sensitive-data-guard
git push -u origin office-ui
```

- [ ] **Step 6: session-scribe CLOSE** — record the session; note the
  merge decision (both `service-story` and `office-ui`) belongs to the
  human.

---

## Not doing, and why

- **Dark mode for the office** — spec chose light-first; tokens make dark a
  later cheap add. The PWA keeps its own adaptive scheme.
- **A real logo** — the rail ships a brand-blue "C" mark; swap when the
  file arrives (one component line).
- **Tailwind or any CSS framework** — repo idiom is plain scoped CSS; no
  third-party anything.
- **Google OAuth / Calendar sync** — direction recorded in placeholders
  and the spec only.
- **Rebuilding forms/tables Apollo-dense** — Approach C explicitly deferred
  the component-library rebuild.
