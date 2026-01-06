import fs from "fs";
import path from "path";

/**
 * Lightweight rotating logger for per-tick market metrics.
 * Stores an in-memory ring buffer and optionally appends JSON lines
 * to a log file with a simple line-count rotation.
 */
export class TickMetricsLogger {
  constructor({ maxEntries = 1500, filePath = null, rotateEvery = 5000 } = {}) {
    this.maxEntries = maxEntries;
    this.filePath = filePath;
    this.rotateEvery = rotateEvery;
    this.buffer = [];
    this.lineCount = 0;

    if (this.filePath) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  record(entry) {
    if (!entry) return null;
    const copy = { ...entry };
    this.buffer.push(copy);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    if (this.filePath) {
      this.#appendToFile(copy);
    }
    return copy;
  }

  latest(limit = 100) {
    const count = Math.max(1, Math.min(limit, this.buffer.length || 1));
    return this.buffer.slice(-count);
  }

  #appendToFile(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFile(this.filePath, line, (err) => {
      if (err) {
        console.error("[metrics] failed to append", err);
        return;
      }
      this.lineCount += 1;
      if (this.lineCount >= this.rotateEvery) {
        this.#rotate();
      }
    });
  }

  #rotate() {
    if (!this.filePath) return;
    this.lineCount = 0;
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const rotated = path.join(dir, `${base}.1`);
    fs.rename(this.filePath, rotated, (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("[metrics] rotate failed", err);
      }
    });
  }
}
