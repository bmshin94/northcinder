import { REPOSITORY_URL, SITE_URL } from './public-coordinates';
import { MAINTAINER, SITE_PAGES, type SitePage } from './site-content';

export interface FaqItem {
  question: string;
  answer: string;
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

type Schema = Record<string, unknown>;

const organizationId = SITE_URL ? `${SITE_URL}/#organization` : undefined;
const maintainerId = SITE_URL ? `${SITE_URL}/#maintainer` : undefined;
const websiteId = SITE_URL ? `${SITE_URL}/#website` : undefined;

export function publicUrl(path: string): string | undefined {
  return SITE_URL ? new URL(path, `${SITE_URL}/`).href : undefined;
}

export function organizationSchema(): Schema | undefined {
  const url = publicUrl('/');
  if (!url || !organizationId) return undefined;
  return {
    '@type': 'Organization',
    '@id': organizationId,
    name: 'NorthCinder',
    url,
    logo: publicUrl('/mark.svg'),
    sameAs: REPOSITORY_URL ? [REPOSITORY_URL] : [],
  };
}

export function maintainerSchema(): Schema | undefined {
  if (!maintainerId) return undefined;
  return {
    '@type': 'Person',
    '@id': maintainerId,
    name: MAINTAINER.name,
    url: MAINTAINER.url,
    jobTitle: MAINTAINER.jobTitle,
    sameAs: [MAINTAINER.url],
    knowsAbout: ['Model Context Protocol', 'agent-native software', 'local-first software', 'human-in-the-loop systems'],
  };
}

export function homepageSchemas(faqs: readonly FaqItem[] = []): Schema[] {
  const homepage = publicUrl('/');
  if (!homepage || !organizationId || !maintainerId || !websiteId) return [];
  return [
    organizationSchema(),
    maintainerSchema(),
    {
      '@type': 'WebSite',
      '@id': websiteId,
      url: homepage,
      name: 'NorthCinder',
      description: SITE_PAGES.home.description,
      inLanguage: 'en',
      publisher: { '@id': organizationId },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${homepage}#software`,
      name: 'NorthCinder',
      description: SITE_PAGES.home.description,
      url: homepage,
      applicationCategory: 'ShoppingApplication',
      operatingSystem: 'Cross-platform',
      softwareVersion: '0.1.2',
      license: 'https://opensource.org/license/mit',
      downloadUrl: 'https://www.npmjs.com/package/northcinder',
      codeRepository: REPOSITORY_URL,
      author: { '@id': maintainerId },
      publisher: { '@id': organizationId },
    },
    faqSchema(faqs),
  ].filter((schema): schema is Schema => schema !== undefined);
}

function breadcrumbSchema(items: readonly BreadcrumbItem[]): Schema | undefined {
  const itemListElement = items.flatMap((item, index) => {
    const itemUrl = publicUrl(item.path);
    return itemUrl ? [{
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: itemUrl,
    }] : [];
  });
  return itemListElement.length > 0 ? { '@type': 'BreadcrumbList', itemListElement } : undefined;
}

function faqSchema(faqs: readonly FaqItem[]): Schema | undefined {
  return faqs.length >= 2 ? {
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  } : undefined;
}

export function articleSchemas(
  page: SitePage,
  breadcrumbs: readonly BreadcrumbItem[],
  faqs: readonly FaqItem[] = [],
  extra: readonly Schema[] = [],
): Schema[] {
  const url = publicUrl(page.path);
  if (!url || !organizationId || !maintainerId) return [];
  return [
    organizationSchema(),
    maintainerSchema(),
    {
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: page.title,
      description: page.description,
      url,
      mainEntityOfPage: url,
      datePublished: page.published,
      dateModified: page.modified,
      inLanguage: 'en',
      author: { '@id': maintainerId },
      publisher: { '@id': organizationId },
    },
    breadcrumbSchema(breadcrumbs),
    faqSchema(faqs),
    ...extra,
  ].filter((schema): schema is Schema => schema !== undefined);
}

export function aboutSchemas(
  page: SitePage,
  breadcrumbs: readonly BreadcrumbItem[],
  faqs: readonly FaqItem[] = [],
): Schema[] {
  const url = publicUrl(page.path);
  if (!url || !organizationId || !maintainerId) return [];
  return [
    organizationSchema(),
    maintainerSchema(),
    {
      '@type': 'AboutPage',
      '@id': `${url}#page`,
      name: page.title,
      description: page.description,
      url,
      datePublished: page.published,
      dateModified: page.modified,
      about: [{ '@id': organizationId }, { '@id': maintainerId }],
    },
    breadcrumbSchema(breadcrumbs),
    faqSchema(faqs),
  ].filter((schema): schema is Schema => schema !== undefined);
}

export function evidenceDatasetSchema(page: SitePage): Schema | undefined {
  const url = publicUrl(page.path);
  if (!url || !organizationId) return undefined;
  return {
    '@type': 'Dataset',
    '@id': `${url}#dataset`,
    name: 'NorthCinder deterministic ranking verification results',
    description: page.description,
    url,
    datePublished: page.published,
    dateModified: page.modified,
    license: 'https://opensource.org/license/mit',
    creator: { '@id': organizationId },
    isBasedOn: REPOSITORY_URL ? `${REPOSITORY_URL}/blob/main/docs/NEUTRALITY-AUDIT.md` : undefined,
    variableMeasured: [
      'input-order divergence count',
      'sponsored-offer rank improvement count',
      'ranking-weight delta divergence count',
    ],
  };
}

export function howToSchema(page: SitePage): Schema | undefined {
  const url = publicUrl(page.path);
  if (!url) return undefined;
  return {
    '@type': 'HowTo',
    '@id': `${url}#howto`,
    name: 'Install NorthCinder as a local MCP server',
    description: page.description,
    totalTime: 'PT10M',
    tool: [{ '@type': 'HowToTool', name: 'Node.js 20 or later' }, { '@type': 'HowToTool', name: 'An MCP-compatible AI app' }],
    step: [
      { '@type': 'HowToStep', position: 1, name: 'Run the initializer', text: 'Run npx northcinder init in a terminal.' },
      { '@type': 'HowToStep', position: 2, name: 'Choose local mode', text: 'Follow the prompts to create buyer-owned local configuration.' },
      { '@type': 'HowToStep', position: 3, name: 'Connect the MCP server', text: 'Copy the generated MCP configuration into your AI app.' },
      { '@type': 'HowToStep', position: 4, name: 'Try a constrained brief', text: 'Ask the connected agent to compare products with explicit requirements and a budget.' },
    ],
  };
}
