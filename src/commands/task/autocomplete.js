import { getTaskAutocompleteSuggestions } from '../../notion/database.js';

const AUTOCOMPLETE_LIMIT = 25;

function formatDateForAutocomplete(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function buildDateAutocompleteChoices(focusedValue = '') {
  const normalizedFocused = String(focusedValue || '').trim().toLowerCase();
  const now = new Date();
  const candidates = [];

  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const formatted = formatDateForAutocomplete(date);
    candidates.push(formatted);
  }


  const seen = new Set();
  return candidates
    .filter(value => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      if (!normalizedFocused) {
        return true;
      }

      return normalized.includes(normalizedFocused);
    })
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(value => ({ name: value, value }));
}

function format12HourTime(hour24, minute) {
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function buildTimeAutocompleteChoices(focusedValue = '') {
  const normalizedFocused = String(focusedValue || '').trim().toLowerCase();
  const candidates = [];

  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      const time24 = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const time12 = format12HourTime(hour, minute);
      candidates.push(time24, time12);
    }
  }

  const seen = new Set();
  return candidates
    .filter(value => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      if (!normalizedFocused) {
        return true;
      }

      return normalized.includes(normalizedFocused);
    })
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(value => ({ name: value, value }));
}

export async function handleTaskAutocomplete(interaction) {
  if (
    interaction.commandName !== 'task' &&
    interaction.commandName !== 'calendar' &&
    interaction.commandName !== 'mytasks' &&
    interaction.commandName !== 'todo'
  ) {
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (!focused) {
    await interaction.respond([]);
    return;
  }

  if (focused.name === 'start_date' || focused.name === 'end_date') {
    await interaction.respond(buildDateAutocompleteChoices(String(focused.value || '')));
    return;
  }

  if (focused.name === 'start_time' || focused.name === 'end_time') {
    await interaction.respond(buildTimeAutocompleteChoices(String(focused.value || '')));
    return;
  }

  if (
    focused.name !== 'department' &&
    focused.name !== 'status' &&
    focused.name !== 'organization'
  ) {
    await interaction.respond([]);
    return;
  }

  try {
    const suggestions = await getTaskAutocompleteSuggestions(focused.name, String(focused.value || ''));
    await interaction.respond(suggestions);
  } catch (error) {
    console.error('Task autocomplete failed:', error.message);
    await interaction.respond([]);
  }
}
