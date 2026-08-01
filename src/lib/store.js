'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, createDefaultData } = require('./defaults');
const { dedupeEvents } = require('./events');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = createDefaultData();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = this.#normalize(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#backupBrokenFile();
      }
      this.data = createDefaultData();
      this.save();
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  update(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }

  #backupBrokenFile() {
    try {
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      fs.copyFileSync(this.filePath, backupPath);
    } catch {
      // A damaged settings file should not prevent the monitor from starting.
    }
  }

  #normalize(parsed) {
    const fallback = createDefaultData();
    const channels = Array.isArray(parsed?.channels)
      ? parsed.channels.filter((channel) => typeof channel?.id === 'string')
      : fallback.channels;

    return {
      version: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed?.settings || {}),
        pollIntervalSeconds: clampInterval(parsed?.settings?.pollIntervalSeconds),
        subscriberChartMode: normalizeSubscriberChartMode(parsed?.settings?.subscriberChartMode)
      },
      channels,
      events: dedupeEvents(parsed?.events, 100)
    };
  }
}

function clampInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.pollIntervalSeconds;
  return Math.min(300, Math.max(15, Math.round(numeric)));
}

function normalizeSubscriberChartMode(value) {
  return value === 'daily' ? 'daily' : DEFAULT_SETTINGS.subscriberChartMode;
}

module.exports = { JsonStore, clampInterval, normalizeSubscriberChartMode };
