import {
  fetchDatabaseCards,
  formatCardForTracking,
} from '../notion/database.js';
import stateTracker from '../sync/tracker.js';
import {
  createDeadlineReminderEmbeds,
  createCalendarOverviewEmbeds,
  createDailyReportEmbed,
} from '../sync/syncer.js';
import {
  filterCardsForChannel,
  toNormalizedDepartmentSet,
  parseCommaSeparatedLookupValues,
  filterCardsByDepartmentFilters,
  cardMatchesOrganizationSet,
} from '../sync/filters.js';
import { buildDepartmentRoleMentions } from '../discord/roles.js';
import { sendEmbedsToChannel } from '../discord/channels.js';

export async function runReminderCheck(channels) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);
  const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});
  const reminderSnoozeByCardId = stateTracker.getMeta('deadlineSnoozeByCardId', {});
  const reminderCounts = [];

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const departmentRoleMentions = buildDepartmentRoleMentions(channel);

    const reminderResult = createDeadlineReminderEmbeds(
      channelTrackedCards,
      departmentRoleMentions,
      reminderStateByCardId,
      new Date(),
      { ignoreDailyLimit: true, snoozeStateByCardId: reminderSnoozeByCardId }
    );

    if (reminderResult.embeds.length > 0) {
      await sendEmbedsToChannel(channel, reminderResult.embeds);
    }

    reminderCounts.push(reminderResult.embeds.length);
  }

  return reminderCounts;
}

export async function runCalendarOverview(channels, range = 'week', now = new Date(), departmentFilter = null, organizationFilter = null) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  const effectiveOrgFilter = organizationFilter; // No default filter for viewing unless specified
  const orgSet = effectiveOrgFilter ? toNormalizedDepartmentSet(parseCommaSeparatedLookupValues(effectiveOrgFilter)) : null;

  for (const channel of channels) {
    let channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);

    // Only filter by Organization if explicitly provided in the command
    if (orgSet && orgSet.size > 0) {
      channelTrackedCards = channelTrackedCards.filter(card => cardMatchesOrganizationSet(card, orgSet));
    }

    if (departmentFilter) {
      const filters = parseCommaSeparatedLookupValues(departmentFilter);
      channelTrackedCards = filterCardsByDepartmentFilters(channelTrackedCards, filters);
    }

    const filterParts = [];
    if (departmentFilter) filterParts.push(departmentFilter);
    if (effectiveOrgFilter && effectiveOrgFilter !== 'SMO CAMT') filterParts.push(effectiveOrgFilter);
    const filterTitle = filterParts.length > 0 ? `: ${filterParts.join(' | ')}` : '';
    const titlePrefix = `📅 Calendar${filterTitle}`;

    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, range, now, {
      title: titlePrefix,
      organization: effectiveOrgFilter || 'SMO CAMT',
    });
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}

export async function runDailyDigest(channels, now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const embed = createDailyReportEmbed(channelTrackedCards, now);
    await sendEmbedsToChannel(channel, [embed], { singleMessage: true });
  }
}

export async function runWeeklyDigest(channels, now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, 'week', now, {
      title: '🗓️ Weekly Digest',
    });
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}

export async function runMonthlyOverview(channels, now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, 'month', now, {
      title: '📅 Monthly Overview',
    });
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}
