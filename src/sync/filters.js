import config from '../config.js';

export function normalizeLookupText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

export function getDepartmentValues(properties = {}) {
  const departmentValue = Object.entries(properties).find(
    ([key]) => {
      const low = key.toLowerCase();
      return low.includes('department') || low.includes('dept') || low === 'ฝ่าย';
    }
  )?.[1];

  if (Array.isArray(departmentValue)) {
    return departmentValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof departmentValue === 'string') {
    return departmentValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function toNormalizedDepartmentSet(departmentFilters = []) {
  const normalized = new Set();

  for (const department of departmentFilters) {
    const normalizedValue = normalizeLookupText(department);
    if (normalizedValue) {
      normalized.add(normalizedValue);
    }
  }

  return normalized;
}

export function cardMatchesDepartmentSet(card, departmentSet) {
  if (!(departmentSet instanceof Set) || departmentSet.size === 0) {
    return true;
  }

  const departments = getDepartmentValues(card?.properties || {});
  return departments.some(dept => departmentSet.has(normalizeLookupText(dept)));
}

/**
 * Filter cards to those matching any of the given department names (e.g. the
 * caller's Discord role names) and an optional status filter. When no status
 * filter is given, Done tasks are excluded by default (used by /mytasks).
 */
export function filterCardsByDepartmentNamesAndStatus(
  cards,
  departmentNames = [],
  statusFilters = [],
  { excludeDoneWhenNoStatus = true } = {}
) {
  const departmentSet = toNormalizedDepartmentSet(departmentNames);
  const statusSet = new Set(
    statusFilters.map(value => normalizeLookupText(value)).filter(Boolean)
  );

  return cards.filter(card => {
    if (departmentSet.size > 0 && !cardMatchesDepartmentSet(card, departmentSet)) {
      return false;
    }

    const normalizedStatuses = getStatusValues(card?.properties || {})
      .map(value => normalizeLookupText(value));

    if (statusSet.size > 0) {
      return normalizedStatuses.some(status => statusSet.has(status));
    }

    if (excludeDoneWhenNoStatus) {
      return !normalizedStatuses.some(status => status.includes('done'));
    }

    return true;
  });
}

function getOrganizationValues(properties = {}) {
  const orgValue = Object.entries(properties).find(
    ([key]) => {
      const low = key.toLowerCase();
      return low.includes('organization') || low.includes('organisation') || low === 'องค์กร';
    }
  )?.[1];

  if (Array.isArray(orgValue)) {
    return orgValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof orgValue === 'string') {
    return orgValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function cardMatchesOrganizationSet(card, organizationSet) {
  if (!(organizationSet instanceof Set) || organizationSet.size === 0) {
    return true;
  }

  const organizations = getOrganizationValues(card?.properties || {});
  if (organizations.length === 0) {
    // If no organization is specified on the card, we consider it a match if "SMO CAMT" is in the filter set,
    // assuming it's the default.
    return organizationSet.has(normalizeLookupText('SMO CAMT'));
  }

  return organizations.some(org => organizationSet.has(normalizeLookupText(org)));
}

export function getChannelDepartmentFilters(channelId) {
  if (Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)) {
    return config.sync.channelDepartmentsByChannelId[channelId];
  }

  return config.sync.trackedDepartments;
}

function hasChannelSpecificDepartmentRouting() {
  return Object.keys(config.sync.channelDepartmentsByChannelId).length > 0;
}

export function formatDepartmentFilterForDisplay(departmentFilters = []) {
  if (!Array.isArray(departmentFilters) || departmentFilters.length === 0) {
    return 'ALL';
  }

  return departmentFilters.join(' | ');
}

export function filterCardsByDepartmentFilters(cards, departmentFilters = []) {
  const departmentSet = toNormalizedDepartmentSet(departmentFilters);
  return cards.filter(card => cardMatchesDepartmentSet(card, departmentSet));
}

export function filterCardsForChannel(cards, channelId) {
  // When per-channel routing is configured, do not fall back for unmapped channels.
  if (
    hasChannelSpecificDepartmentRouting() &&
    !Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)
  ) {
    return [];
  }

  return filterCardsByDepartmentFilters(cards, getChannelDepartmentFilters(channelId));
}

export function getSyncScopeDepartmentSet() {
  const mergedSet = new Set();

  for (const channelId of config.discord.channelIds) {
    if (
      hasChannelSpecificDepartmentRouting() &&
      !Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)
    ) {
      continue;
    }

    const channelSet = toNormalizedDepartmentSet(getChannelDepartmentFilters(channelId));
    if (channelSet.size === 0) {
      return new Set();
    }

    for (const department of channelSet) {
      mergedSet.add(department);
    }
  }

  return mergedSet;
}

export function filterCardsBySyncScope(cards) {
  const syncScopeDepartmentSet = getSyncScopeDepartmentSet();
  return cards.filter(card => cardMatchesDepartmentSet(card, syncScopeDepartmentSet));
}

export function getDepartmentsForChannel(channelId) {
  return config.sync.channelDepartmentsByChannelId[channelId] || [];
}

export function parseCommaSeparatedLookupValues(rawValue) {
  if (typeof rawValue !== 'string') {
    return [];
  }

  const seen = new Set();
  const values = [];

  for (const item of rawValue.split(/[\u002C\uFF0C\u3001]/)) {
    const value = item.trim();
    const normalized = normalizeLookupText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    values.push(value);
  }

  return values;
}

function getStatusValue(properties = {}) {
  return (
    Object.entries(properties).find(([key]) => {
      const low = key.toLowerCase();
      return low === 'status' || low === 'state' || low === 'เบอร์' || low === 'สถานะ';
    })?.[1] || ''
  );
}

export function getStatusValues(properties = {}) {
  const statusValue = getStatusValue(properties);

  if (Array.isArray(statusValue)) {
    return statusValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof statusValue === 'string') {
    const normalizedValue = statusValue.trim();
    return normalizedValue ? [normalizedValue] : [];
  }

  return [];
}
