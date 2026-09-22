'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, createDefaultData } = require('./defaults');
const { dedupeEvents } = require('./events');
const { normalizeVideoViewHistories } = require('./video-history');
const { pruneCloud } = require('./cloud-sync');

class JsonStore {
  constructor(filePath, { backupIntervalMs = 5 * 60_000 } = {}) {
    this.filePath = filePath;
    this.data = createDefaultData();
    this.backupIntervalMs = backupIntervalMs;
    this.lastBackupAt = 0;
    this.recovery = null;
    this.writable = false;
  }

  load() {
    this.writable = false;
    this.recovery = null;
    try {
      this.data = this.#read(this.filePath);
      this.writable = true;
    } catch (error) {
      if (!isRecoverableReadError(error)) throw error;
      const candidates = [`${this.filePath}.tmp`, `${this.filePath}.bak`, `${this.filePath}.bak.1`];
      let foundArtifact = error.code !== 'ENOENT';
      for (const candidate of candidates) {
        let recovered;
        try { recovered = this.#read(candidate); }
        catch (candidateError) {
          if (!isRecoverableReadError(candidateError)) throw candidateError;
          if (candidateError.code !== 'ENOENT') foundArtifact = true;
          continue;
        }
        if (error.code !== 'ENOENT') this.#backupBrokenFile();
        this.data = recovered;
        this.writable = true;
        this.recovery = { source: path.basename(candidate) };
        // Leave backup generations intact during recovery.
        this.lastBackupAt = Date.now();
        this.#writeAtomic(this.filePath, JSON.stringify(this.data, null, 2));
        return this.data;
      }
      if (foundArtifact) {
        const failure = new Error('저장된 기록을 읽을 수 없습니다. 기존 파일을 보존했습니다. 백업에서 복구한 뒤 다시 실행해 주세요.');
        failure.code = 'STORE_RECOVERY_REQUIRED';
        throw failure;
      }
      this.writable = true;
      this.data = createDefaultData();
      this.save();
    }
    return this.data;
  }

  save() {
    if (!this.writable) throw new Error('저장 파일을 정상적으로 불러오기 전에는 덮어쓸 수 없습니다.');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const serialized = JSON.stringify(this.data, null, 2);
    if (Date.now() - this.lastBackupAt >= this.backupIntervalMs) {
      const backupPath = `${this.filePath}.bak`;
      // Only rotate a readable generation; a corrupt backup must not replace a good older one.
      try {
        const backup = this.#read(backupPath);
        this.#writeAtomic(`${backupPath}.1`, JSON.stringify(backup, null, 2));
      } catch (error) { if (!isRecoverableReadError(error)) throw error; }
      this.#writeAtomic(backupPath, serialized);
      this.lastBackupAt = Date.now();
    }
    this.#writeAtomic(this.filePath, serialized);
  }

  update(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }

  #backupBrokenFile() {
    const backupPath = `${this.filePath}.broken-${Date.now()}`;
    fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  #writeAtomic(target, serialized) {
    const temporaryPath = `${target}.tmp`;
    const descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporaryPath, target);
  }

  #read(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.channels)
      || parsed.channels.some(channel => typeof channel?.id !== 'string')) {
      const error = new Error('저장 파일의 채널 목록 형식이 올바르지 않습니다.');
      error.code = 'STORE_INVALID';
      throw error;
    }
    return this.#normalize(parsed);
  }

  #normalize(parsed) {
    const fallback = createDefaultData();
    const channels = Array.isArray(parsed?.channels)
      ? parsed.channels.filter((channel) => typeof channel?.id === 'string').map((channel) => ({
        ...channel,
        videoViewHistories: normalizeVideoViewHistories(channel.videoViewHistories)
      }))
      : fallback.channels;

    return {
      version: 3,
      cloud: pruneCloud(parsed?.cloud),
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

function isRecoverableReadError(error) {
  return error.code === 'ENOENT' || error.code === 'STORE_INVALID' || error instanceof SyntaxError;
}

function normalizeSubscriberChartMode(value) {
  return value === 'daily' ? 'daily' : DEFAULT_SETTINGS.subscriberChartMode;
}

module.exports = { JsonStore, clampInterval, normalizeSubscriberChartMode };
