export interface SitePage {
  path: string;
  title: string;
  description: string;
  label: string;
  eyebrow: string;
  published: string;
  modified: string;
}

const sharedDates = {
  published: '2026-08-17',
  modified: '2026-08-18',
} as const;

export const SITE_PAGES = {
  home: {
    path: '/',
    title: 'NorthCinder | Buyer-run shopping-agent MCP server',
    description: 'Open-source MCP software that compares products against your brief, explains its ranking, and requires explicit approval before checkout.',
    label: 'Home',
    eyebrow: 'The buyer-loyal shopping agent',
    ...sharedDates,
  },
  install: {
    path: '/install/',
    title: 'Install NorthCinder | Local shopping-agent MCP setup',
    description: 'Install NorthCinder with npx, connect the local MCP server to your AI app, and verify the buyer-run setup without a NorthCinder account.',
    label: 'Install',
    eyebrow: 'Local setup',
    ...sharedDates,
  },
  ranking: {
    path: '/ranking/',
    title: 'How NorthCinder ranks products | Open deterministic ranking',
    description: 'See how NorthCinder ranks disclosed offers against buyer criteria, explains every score, and keeps sponsored offers below organic results.',
    label: 'Ranking',
    eyebrow: 'Inspectable ordering',
    ...sharedDates,
  },
  checkoutSafety: {
    path: '/checkout-safety/',
    title: 'Shopping-agent checkout safety | Signed purchase mandates',
    description: 'Learn how NorthCinder separates search from purchase with exact-payload approval, single-use nonces, spending caps, and no raw card handling.',
    label: 'Checkout safety',
    eyebrow: 'Human purchase control',
    ...sharedDates,
  },
  storeCoverage: {
    path: '/store-coverage/',
    title: 'Store coverage | NorthCinder shopping-agent adapters',
    description: 'Check what each NorthCinder store adapter can do, which platform approvals are required, and how unavailable coverage is reported.',
    label: 'Store coverage',
    eyebrow: 'Honest availability',
    ...sharedDates,
  },
  evidence: {
    path: '/evidence/',
    title: 'Verification evidence | NorthCinder ranking audit',
    description: 'Review NorthCinder deterministic audit results for input-order invariance, sponsored-offer behavior, and published ranking weights.',
    label: 'Evidence',
    eyebrow: 'Dated, reproducible proof',
    ...sharedDates,
  },
  about: {
    path: '/about/',
    title: 'About NorthCinder | Buyer-run open-source shopping software',
    description: 'NorthCinder is MIT-licensed shopping-agent software maintained in public, with no hosted service, telemetry, affiliate ranking, or seller placement sales.',
    label: 'About',
    eyebrow: 'Project and maintainer',
    ...sharedDates,
  },
} satisfies Record<string, SitePage>;

export const INDEXABLE_PAGES = Object.values(SITE_PAGES);

export const MAINTAINER = {
  name: 'Cinderline',
  url: 'https://github.com/cinderline',
  jobTitle: 'Open-source AI developer',
} as const;
