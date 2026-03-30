import notion from './client.js';
import config from '../config.js';

/**
 * Extracts text value from Notion rich text array
 */
function extractRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => rt.plain_text).join('');
}

function extractNotionDateValue(dateValue) {
  if (!dateValue?.start) {
    return null;
  }

  if (dateValue.end) {
    return `${dateValue.start} → ${dateValue.end}`;
  }

  return dateValue.start;
}

function extractPageTitleFromProperties(properties) {
  if (!properties || typeof properties !== 'object') {
    return null;
  }

  for (const property of Object.values(properties)) {
    if (property?.type === 'title') {
      return extractRichText(property.title) || null;
    }
  }

  return null;
}

async function getPageTitle(pageId, titleCache) {
  // Avoid repeated API calls when multiple cards point to the same relation page.
  if (titleCache.has(pageId)) {
    return titleCache.get(pageId);
  }

  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const title = extractPageTitleFromProperties(page.properties) || `Untitled (${pageId.slice(0, 8)})`;
    titleCache.set(pageId, title);
    return title;
  } catch (error) {
    const fallbackTitle = `Unknown (${pageId.slice(0, 8)})`;
    titleCache.set(pageId, fallbackTitle);
    console.warn(`⚠️  Failed to resolve relation title for ${pageId}: ${error.message}`);
    return fallbackTitle;
  }
}

async function extractRelationTitles(relationItems, titleCache) {
  if (!Array.isArray(relationItems) || relationItems.length === 0) {
    return [];
  }

  const titles = [];
  for (const relation of relationItems) {
    const title = await getPageTitle(relation.id, titleCache);
    titles.push(title);
  }

  return titles;
}

/**
 * Extracts value from Notion formula object.
 */
function extractFormulaValue(formula) {
  if (!formula) return null;

  switch (formula.type) {
    case 'string':
      return formula.string;
    case 'number':
      return formula.number;
    case 'boolean':
      return formula.boolean;
    case 'date':
      return extractNotionDateValue(formula.date);
    default:
      return null;
  }
}

/**
 * Extracts value from Notion property based on type
 */
async function extractPropertyValue(property, titleCache) {
  if (!property) return null;

  switch (property.type) {
    case 'title':
      return extractRichText(property.title);
    case 'rich_text':
      return extractRichText(property.rich_text);
    case 'status':
      return property.status?.name || null;
    case 'select':
      return property.select?.name || null;
    case 'multi_select':
      return property.multi_select?.map(m => m.name) || [];
    case 'people':
      return property.people?.map(p => p.name) || [];
    case 'date':
      return extractNotionDateValue(property.date);
    case 'formula':
      return extractFormulaValue(property.formula);
    case 'relation':
      // Relations store page IDs; we resolve and keep only human-friendly titles.
      return extractRelationTitles(property.relation, titleCache);
    case 'url':
      return property.url || null;
    case 'number':
      return property.number;
    case 'checkbox':
      return property.checkbox;
    default:
      return null;
  }
}

/**
 * Fetches all pages from a Notion database with pagination
 */
export async function fetchDatabaseCards() {
  try {
    const cards = [];
    const relationTitleCache = new Map();
    let cursor = undefined;
    let isFirstPage = true;

    while (true) {
      const response = await notion.databases.query({
        database_id: config.notion.databaseId,
        start_cursor: cursor,
      });

      // Extract relevant properties from each page
      for (const page of response.results) {
        const cardData = {
          id: page.id,
          url: page.url,
          properties: {},
        };

        // Extract all properties from the page
        for (const [propName, propValue] of Object.entries(page.properties)) {
          cardData.properties[propName] = await extractPropertyValue(propValue, relationTitleCache);
        }

        // Log first card's properties for debugging
        if (isFirstPage && cards.length === 0) {
          console.log('🔍 Database properties found:', Object.keys(cardData.properties));
          isFirstPage = false;
        }

        cards.push(cardData);
      }

      // Check if there are more results
      if (!response.has_more) {
        break;
      }
      cursor = response.next_cursor;
    }

    return cards;
  } catch (error) {
    console.error('Error fetching Notion database:', error.message);
    throw error;
  }
}

/**
 * Formats card data into a standardized structure for tracking
 */
export function formatCardForTracking(card) {
  // Find the status property (usually called "Status", but this varies)
  // You may need to customize this based on your database schema
  const properties = card.properties;

  const formatted = {
    id: card.id,
    url: card.url,
    timestamp: new Date().toISOString(),
    properties: properties,
  };

  return formatted;
}

export default {
  fetchDatabaseCards,
  formatCardForTracking,
};
