'use strict';

/* ---------------------------------------------------------------
   A JSON document on disk, written atomically, with every mutation
   serialised through one promise chain.

   Extracted from lib/news.js when settings needed the same guarantees.
   Both documents are small, both are written from an admin console where
   two saves can overlap, and a half-written file is the failure that
   loses a post or a join code with no obvious cause.
--------------------------------------------------------------- */

const crypto = require('crypto');
const fsp = require('fs/promises');

class JsonStore {
    /**
     * `defaults` is what a missing file starts from, and also what a
     * partially-populated one is filled out with on load — so adding a
     * field in a later version does not require a migration.
     */
    constructor(file, defaults) {
        this.file = file;
        this.defaults = defaults;
        this.state = structuredClone(defaults);
        this.writeChain = Promise.resolve();
    }

    async load() {
        try {
            const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
            this.state = { ...structuredClone(this.defaults), ...parsed };
        } catch (error) {
            // A missing file is a first run, not a fault. Anything else --
            // corrupt JSON, bad permissions -- must be loud, because
            // silently starting empty is indistinguishable from having
            // lost everything.
            if (error.code !== 'ENOENT') throw error;
            this.state = structuredClone(this.defaults);
            await this.persist();
        }
        return this;
    }

    /** Atomic write: temp file, fsync, rename. Survives a mid-write crash. */
    async persist() {
        const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        const body = JSON.stringify(this.state, null, 2);

        const handle = await fsp.open(tmp, 'w');
        try {
            await handle.writeFile(body, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(tmp, this.file);
    }

    /** Run `fn(state)` with exclusive access, then persist. */
    mutate(fn) {
        const run = this.writeChain.then(async () => {
            const result = await fn(this.state);
            await this.persist();
            return result;
        });
        // The chain must survive a rejected mutation, or one bad save
        // wedges every write that follows it.
        this.writeChain = run.catch(() => {});
        return run;
    }
}

module.exports = { JsonStore };
