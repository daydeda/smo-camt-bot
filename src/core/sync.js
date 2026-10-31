import config from '../config.js';
import stateTracker from '../sync/tracker.js';
import {
  fetchDatabaseCards,
  formatCardForTracking,
} from '../notion/database.js';
import {
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
  createDeadlineReminderEmbeds,
  hasRequiredTaskDetails,
  getMissingRequiredTaskDetails,
} from '../sync/syncer.js';
import {
  getSyncScopeDepartmentSet,
  filterCardsBySyncScope,
  formatDepartmentFilterForDisplay,
  cardMatchesDepartmentSet,
  filterCardsForChannel,
} from '../sync/filters.js';
import { buildDepartmentRoleMentions } from '../discord/roles.js';
import { fetchConfiguredChannels, sendEmbedsToChannel } from '../discord/channels.js';
import {
  HARD_DEDUPE_META_KEY,
  HARD_DEDUPE_HYDRATION_META_KEY,
  getMonthKey,
  pruneHardDedupeHistory,
  applyHardDedupeToEmbeds,
  markHardDedupeKeys,
  shouldHydrateHardDedupeForChannel,
  hydrateHardDedupeHistoryFromDiscord,
} from '../sync/dedupe.js';
import { runMonthlyOverview } from '../scheduled/runners.js';
import { refreshTodoBoards } from '../discord/todoBoards.js';
import { getDepartmentValues } from '../sync/filters.js';
import { recordSyncSuccess, recordSyncFailure } from './health.js';

let isRunning = false;

async function refreshBoardsForChangedDepartments(changedCards, allCards) {
  const departments = new Set();
  for (const card of changedCards) {
    for (const department of getDepartmentValues(card?.properties || {})) {
      departments.add(department);
    }
  }

  for (const department of departments) {
    try {
      await refreshTodoBoards(department, allCards);
    } catch (error) {
      console.error(`To-do board refresh failed for ${department}: ${error.message}`);
    }
  }
}

/**
 * Main sync loop - fetches Notion database and posts changes to Discord
 */
export async function syncNotionToDiscord() {
  if (isRunning) {
    console.log('⏳ Sync already in progress, skipping...');
    return;
  }

  isRunning = true;

  try {
    const wasInitialSync = stateTracker.getAllCardIds().length === 0;

    // Fetch current database state
    const cards = await fetchDatabaseCards();
    console.log(`📊 Fetched ${cards.length} cards from Notion database`);

    // Format cards for tracking
    const formattedCards = cards.map(formatCardForTracking);
    const syncScopeDepartmentSet = getSyncScopeDepartmentSet();
    const trackedCards = filterCardsBySyncScope(formattedCards);
    console.log(
      `🏷️  Tracking sync scope (${formatDepartmentFilterForDisplay(config.sync.trackedDepartments)} default): ${trackedCards.length}/${formattedCards.length} cards`
    );

    // Find changed cards
    const {
      changedCards,
      createdCards,
      deletedCards,
      deletedCardIds,
      silentRemovedCardIds,
      skippedNewCards,
    } = findChangedCards(stateTracker, trackedCards, formattedCards);
    const creationNotifiedByCardId = {
      ...stateTracker.getMeta('creationNotifiedByCardId', {}),
    };

    let creationMetaChanged = false;
    for (const deletedId of [...deletedCardIds, ...silentRemovedCardIds]) {
      if (Object.hasOwn(creationNotifiedByCardId, deletedId)) {
        delete creationNotifiedByCardId[deletedId];
        creationMetaChanged = true;
      }
    }

    if (wasInitialSync && Object.keys(creationNotifiedByCardId).length === 0) {
      // Treat existing cards as baseline to avoid flooding create notifications on first run.
      for (const card of trackedCards) {
        creationNotifiedByCardId[card.id] = true;
      }
      creationMetaChanged = true;
    }

    const readyCreatedCards = trackedCards.filter(card => {
      if (creationNotifiedByCardId[card.id]) {
        return false;
      }

      return hasRequiredTaskDetails(card);
    });
    const blockedCreatedCards = trackedCards.filter(card => {
      if (creationNotifiedByCardId[card.id]) {
        return false;
      }

      return !hasRequiredTaskDetails(card);
    });

    // Detail updates should always notify for tracked existing cards, regardless of create-notice state.
    const notifiableChangedCards = changedCards;

    const trackedDeletedCards = deletedCards.filter(card => cardMatchesDepartmentSet(card, syncScopeDepartmentSet));
    const trackedDeletedCardIdSet = new Set(trackedDeletedCards.map(card => card.id));
    const trackedDeletedCardIds = deletedCardIds.filter(cardId => trackedDeletedCardIdSet.has(cardId));

    console.log(
      `📈 Sync summary: created=${createdCards.length}, readyForCreateNotice=${readyCreatedCards.length}, blockedForCreateNotice=${blockedCreatedCards.length}, changed=${changedCards.length}, changedNotified=${notifiableChangedCards.length}, deleted=${trackedDeletedCardIds.length}, silentRemoved=${silentRemovedCardIds.length}, skippedNew=${skippedNewCards}`
    );

    if (blockedCreatedCards.length > 0) {
      const previewCards = blockedCreatedCards.slice(0, 5);
      for (const card of previewCards) {
        const missingFields = getMissingRequiredTaskDetails(card);
        const cardName = card?.properties?.['กิจกรรม'] || card.id;
        console.log(`⛔ Create notice blocked for "${cardName}": missing [${missingFields.join(', ')}]`);
      }

      if (blockedCreatedCards.length > previewCards.length) {
        console.log(`⛔ ...and ${blockedCreatedCards.length - previewCards.length} more blocked card(s)`);
      }
    }

    // Handle deleted cards
    for (const deletedId of trackedDeletedCardIds) {
      console.log(`🗑️  Card deleted: ${deletedId}`);
    }

    if (deletedCardIds.length > 0 || silentRemovedCardIds.length > 0) {
      stateTracker.removeCardStates([...deletedCardIds, ...silentRemovedCardIds]);
    }

    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});
    const reminderSnoozeByCardId = stateTracker.getMeta('deadlineSnoozeByCardId', {});
    const rawHardDedupeHistoryByKey = stateTracker.getMeta(HARD_DEDUPE_META_KEY, {});
    const hardDedupeHistoryByKey = pruneHardDedupeHistory(rawHardDedupeHistoryByKey, now.getTime());
    const rawHardDedupeHydrationMetaByChannelId = stateTracker.getMeta(HARD_DEDUPE_HYDRATION_META_KEY, {});
    const hardDedupeHydrationMetaByChannelId =
      rawHardDedupeHydrationMetaByChannelId && typeof rawHardDedupeHydrationMetaByChannelId === 'object'
        ? { ...rawHardDedupeHydrationMetaByChannelId }
        : {};
    let hardDedupeMetaChanged =
      JSON.stringify(rawHardDedupeHistoryByKey || {}) !== JSON.stringify(hardDedupeHistoryByKey);
    let hardDedupeHydrationMetaChanged = false;

    if (
      readyCreatedCards.length > 0 ||
      notifiableChangedCards.length > 0 ||
      trackedDeletedCards.length > 0
    ) {
      console.log(
        `✏️  Found updates: created=${readyCreatedCards.length}, changed=${notifiableChangedCards.length}, removed=${trackedDeletedCards.length}`
      );
    }

    try {
      const channels = await fetchConfiguredChannels();
      if (channels.length === 0) {
        throw new Error('No configured text channels are available.');
      }

      const channelResults = [];
      for (const channel of channels) {
        if (shouldHydrateHardDedupeForChannel(channel.id, hardDedupeHydrationMetaByChannelId, now.getTime())) {
          const hydrationResult = await hydrateHardDedupeHistoryFromDiscord(channel, hardDedupeHistoryByKey, {
            now,
          });
          hardDedupeHydrationMetaByChannelId[channel.id] = now.toISOString();
          hardDedupeHydrationMetaChanged = true;

          if (hydrationResult.added > 0) {
            hardDedupeMetaChanged = true;
            console.log(
              `🔄 Hydrated ${hydrationResult.added} dedupe key(s) from channel ${channel.id} (messages=${hydrationResult.scannedMessages}, embeds=${hydrationResult.scannedEmbeds})`
            );
          }
        }

        const channelTrackedCards = filterCardsForChannel(trackedCards, channel.id);
        const channelReadyCreatedCards = filterCardsForChannel(readyCreatedCards, channel.id);
        const channelNotifiableChangedCards = filterCardsForChannel(notifiableChangedCards, channel.id);
        const channelTrackedDeletedCards = filterCardsForChannel(trackedDeletedCards, channel.id);
        const departmentRoleMentions = buildDepartmentRoleMentions(channel);
        const reminderResult = createDeadlineReminderEmbeds(
          channelTrackedCards,
          departmentRoleMentions,
          reminderStateByCardId,
          now,
          { snoozeStateByCardId: reminderSnoozeByCardId }
        );
        const createdEmbeds = createCreatedEmbeds(channelReadyCreatedCards, departmentRoleMentions);
        const changedEmbeds = createChangeEmbeds(channelNotifiableChangedCards, departmentRoleMentions);
        const removedEmbeds = createRemovedEmbeds(channelTrackedDeletedCards, departmentRoleMentions);
        const dedupedReminders = applyHardDedupeToEmbeds(reminderResult.embeds, {
          channelId: channel.id,
          messageType: 'reminder',
          scopeToken: todayKey,
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedCreated = applyHardDedupeToEmbeds(createdEmbeds, {
          channelId: channel.id,
          messageType: 'created',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedChanged = applyHardDedupeToEmbeds(changedEmbeds, {
          channelId: channel.id,
          messageType: 'changed',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedRemoved = applyHardDedupeToEmbeds(removedEmbeds, {
          channelId: channel.id,
          messageType: 'removed',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });

        const embeds = [
          ...dedupedReminders.embeds,
          ...dedupedCreated.embeds,
          ...dedupedChanged.embeds,
          ...dedupedRemoved.embeds,
        ];
        const dedupeKeys = [
          ...dedupedReminders.keys,
          ...dedupedCreated.keys,
          ...dedupedChanged.keys,
          ...dedupedRemoved.keys,
        ];
        const skippedByHardDedupe =
          dedupedReminders.skippedCount +
          dedupedCreated.skippedCount +
          dedupedChanged.skippedCount +
          dedupedRemoved.skippedCount;

        channelResults.push({
          channel,
          embeds,
          dedupeKeys,
          skippedByHardDedupe,
          sentReminderCount: dedupedReminders.embeds.length,
          reminderResult,
          channelReadyCreatedCards,
        });
      }

      const hasAnyEmbeds = channelResults.some(result => result.embeds.length > 0);

      if (!hasAnyEmbeds) {
        console.log('✓ No changes detected');
      } else {
        for (const result of channelResults) {
          if (result.embeds.length === 0) {
            continue;
          }

          await sendEmbedsToChannel(result.channel, result.embeds);
          if (markHardDedupeKeys(hardDedupeHistoryByKey, result.dedupeKeys, now.toISOString())) {
            hardDedupeMetaChanged = true;
          }
        }

        const totalHardDedupeSkips = channelResults.reduce(
          (sum, result) => sum + result.skippedByHardDedupe,
          0
        );

        const notifiedCreatedCardIdSet = new Set();
        for (const result of channelResults) {
          for (const card of result.channelReadyCreatedCards) {
            notifiedCreatedCardIdSet.add(card.id);
          }
        }

        for (const cardId of notifiedCreatedCardIdSet) {
          creationNotifiedByCardId[cardId] = true;
        }

        if (notifiedCreatedCardIdSet.size > 0) {
          creationMetaChanged = true;
        }

        const totalReminderCount = channelResults.reduce(
          (sum, result) => sum + result.sentReminderCount,
          0
        );

        console.log(
          `✅ Posted updates to ${channels.length} channel(s) (reminders=${totalReminderCount}, hardDedupeSkipped=${totalHardDedupeSkips})`
        );
      }

      if (!hasAnyEmbeds) {
        const totalHardDedupeSkips = channelResults.reduce(
          (sum, result) => sum + result.skippedByHardDedupe,
          0
        );

        if (totalHardDedupeSkips > 0) {
          console.log(`🔁 Hard dedupe suppressed ${totalHardDedupeSkips} duplicate embed(s).`);
        }
      }

      let mergedReminderStateByCardId = { ...reminderStateByCardId };
      for (const result of channelResults) {
        mergedReminderStateByCardId = {
          ...mergedReminderStateByCardId,
          ...result.reminderResult.reminderStateByCardId,
        };
      }

      stateTracker.setMeta('deadlineReminderByCardId', mergedReminderStateByCardId);
      if (hardDedupeMetaChanged) {
        stateTracker.setMeta(HARD_DEDUPE_META_KEY, hardDedupeHistoryByKey);
      }
      if (hardDedupeHydrationMetaChanged) {
        stateTracker.setMeta(HARD_DEDUPE_HYDRATION_META_KEY, hardDedupeHydrationMetaByChannelId);
      }

      const currentMonthKey = getMonthKey(now);
      const lastMonthlyOverviewKey = stateTracker.getMeta('monthlyOverviewLastSentKey', null);
      if (now.getDate() === 1 && lastMonthlyOverviewKey !== currentMonthKey) {
        await runMonthlyOverview(channels, now);
        stateTracker.setMeta('monthlyOverviewLastSentKey', currentMonthKey);
        console.log('📅 Posted automatic monthly overview.');
      }
    } catch (error) {
      console.error('Error sending Discord message:', error.message);
    }

    if (creationMetaChanged) {
      stateTracker.setMeta('creationNotifiedByCardId', creationNotifiedByCardId);
    }

    // Keep to-do boards in step with Notion: refresh the boards of every
    // department that had a change this cycle. Never let this block sync.
    await refreshBoardsForChangedDepartments(
      [...createdCards, ...changedCards, ...trackedDeletedCards],
      formattedCards
    );

    // Update tracker with current state
    stateTracker.setCardStates(trackedCards);
    recordSyncSuccess({ cardCount: cards.length });
  } catch (error) {
    console.error('❌ Sync error:', error.message);
    recordSyncFailure(error);
  } finally {
    isRunning = false;
  }
}
