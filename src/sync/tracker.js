import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '../../state_tracker.json');
const META_KEY = '__meta';

class StateTracker {
  constructor() {
    this.state = {};
    this.loadState();
  }

  /**
   * Load state from file if it exists
   */
  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        this.state = JSON.parse(data);
        if (!this.state || typeof this.state !== 'object') {
          this.state = {};
        }
        if (!this.state[META_KEY] || typeof this.state[META_KEY] !== 'object') {
          this.state[META_KEY] = {};
        }
        const trackedCardCount = Object.keys(this.state).filter(key => key !== META_KEY).length;
        console.log(`📋 Loaded tracker state with ${trackedCardCount} cards`);
      } else {
        console.log('📋 No previous state found, starting fresh');
        this.state = { [META_KEY]: {} };
      }
    } catch (error) {
      console.error('Error loading state:', error.message);
      this.state = { [META_KEY]: {} };
    }
  }

  /**
   * Save state to file
   */
  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error('Error saving state:', error.message);
    }
  }

  /**
   * Get the stored state for a card
   */
  getCardState(cardId) {
    if (cardId === META_KEY) {
      return null;
    }

    return this.state[cardId] || null;
  }

  /**
   * Update the state for a card
   */
  updateCardState(cardId, cardData) {
    if (cardId === META_KEY) {
      return;
    }

    this.state[cardId] = {
      ...cardData,
      lastUpdated: new Date().toISOString(),
    };
    this.saveState();
  }

  /**
   * Update state for multiple cards and save once.
   */
  setCardStates(cards) {
    const updatedAt = new Date().toISOString();

    for (const card of cards) {
      this.state[card.id] = {
        ...card,
        lastUpdated: updatedAt,
      };
    }

    this.saveState();
  }

  /**
   * Remove a card from state (when deleted)
   */
  removeCardState(cardId) {
    if (cardId === META_KEY) {
      return;
    }

    delete this.state[cardId];
    this.saveState();
  }

  /**
   * Remove multiple cards and save once.
   */
  removeCardStates(cardIds) {
    for (const cardId of cardIds) {
      if (cardId === META_KEY) {
        continue;
      }

      delete this.state[cardId];
    }

    this.saveState();
  }

  /**
   * Get all tracked card IDs
   */
  getAllCardIds() {
    return Object.keys(this.state).filter(cardId => cardId !== META_KEY);
  }

  /**
   * Get metadata value by key
   */
  getMeta(key, defaultValue = null) {
    const meta = this.state[META_KEY] || {};
    if (!Object.hasOwn(meta, key)) {
      return defaultValue;
    }

    return meta[key];
  }

  /**
   * Set metadata value by key
   */
  setMeta(key, value) {
    if (!this.state[META_KEY] || typeof this.state[META_KEY] !== 'object') {
      this.state[META_KEY] = {};
    }

    this.state[META_KEY][key] = value;
    this.saveState();
  }

  /**
   * Clear all state
   */
  clearState() {
    this.state = { [META_KEY]: {} };
    this.saveState();
  }
}

export default new StateTracker();
