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
          lead: 'Order the day so the truck drives less. Route optimization takes each technician\'s stops and sequences them by geography and time windows.',
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
          lead: 'The service schedule beyond today: upcoming work by week and month, capacity ahead of time, and — once the platform sits on the business\'s Google Workspace — two-way sync with Google Calendar.',
          aims: ['Capacity management ahead of the day', 'Google Calendar sync (platform direction)'],
          today: [{ label: 'Today\'s work is on the day board', href: '/schedule' }],
        },
      },
      {
        label: 'Jobs', href: '/service/jobs', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'Every work order across every customer, filterable by status, type and technician. The jobs exist — booked, scheduled, completed, cancelled — this list view across customers does not yet.',
          aims: ['Notes technicians can find', 'One place to see all open work'],
          today: [
            { label: 'A customer\'s jobs are on their record', href: '/' },
            { label: 'Today\'s jobs are on the day board', href: '/schedule' },
          ],
        },
      },
      {
        label: 'Follow-ups', href: '/service/followups', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'The rebooking worklist. When a technician can\'t finish, the reason comes back from the phone — "come back Thursday with the part" — and each one is a job somebody must reschedule before the customer calls first.',
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
          today: [{ label: 'Record and read tests on a customer\'s record', href: '/' }],
        },
      },
      {
        label: 'Checklist templates', href: '/service/templates', status: 'partial',
        placeholder: {
          phase: 'Phase 2 · service & dispatch',
          lead: 'What each kind of visit always covers. The templates exist in code and seed every job\'s checklist; editing them will move here so a new procedure doesn\'t need a developer.',
          aims: ['Consistent service steps for a tech hired in March, by April'],
          today: [{ label: 'Templates seed every new job\'s checklist automatically', href: '/schedule' }],
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
          aims: ['Inventory transfers between store and truck that don\'t break invoicing'],
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
          lead: 'Executive dashboards over the one customer record: revenue by season, service load, what\'s selling.',
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
          lead: 'Ask in plain language — "which pool customers haven\'t booked an opening yet?" AI features read from filtered views, never the raw tables, so a summary can never swallow a gate code (ADR 0003).',
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
          lead: 'The platform sits on top of the business\'s Google Workspace: schedules sync with Google Calendar, Gmail feeds each customer\'s timeline, and Google accounts eventually handle sign-in. Alongside it: Podium (texts), QuickBooks (accounting), and the fleet tracker.',
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
