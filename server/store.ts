// Tiny JSON-file persistence. With dir = null everything stays in memory (sim, tests).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class JsonStore<T> {
  data: T;
  constructor(private dir: string | null, private name: string, init: () => T) {
    const f = this.file();
    this.data = f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : init();
  }
  private file() { return this.dir ? path.join(this.dir, `${this.name}.json`) : null; }
  save() {
    const f = this.file();
    if (!f) return;
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f + '.tmp', JSON.stringify(this.data, null, 2));
    renameSync(f + '.tmp', f);
  }
}
