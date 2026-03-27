import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '../../state_tracker.json');

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
        console.log(`📋 Loaded tracker state with ${Object.keys(this.state).length} cards`);
      } else {
        console.log('📋 No previous state found, starting fresh');
      }
    } catch (error) {
      console.error('Error loading state:', error.message);
      this.state = {};
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
    return this.state[cardId] || null;
  }

  /**
   * Update the state for a card
   */
  updateCardState(cardId, cardData) {
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
    delete this.state[cardId];
    this.saveState();
  }

  /**
   * Remove multiple cards and save once.
   */
  removeCardStates(cardIds) {
    for (const cardId of cardIds) {
      delete this.state[cardId];
    }

    this.saveState();
  }

  /**
   * Get all tracked card IDs
   */
  getAllCardIds() {
    return Object.keys(this.state);
  }

  /**
   * Clear all state
   */
  clearState() {
    this.state = {};
    this.saveState();
  }
}

export default new StateTracker();
