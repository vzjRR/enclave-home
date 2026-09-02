'use strict';

/* ---------------------------------------------------------------
   Computes seconds until the next occurrence of a known daily restart
   schedule -- the same approach the enclave-server-status Discord bot
   uses (src/restartWebhook.js), kept here independently so the website's
   live board can show it too without depending on that bot.

   RESTART_SCHEDULE_TIMES: comma-separated "HH:MM" (24h), e.g. "06:00,18:00".
   RESTART_SCHEDULE_UTC_OFFSET_MINUTES: timezone those times are in, as an
   offset from UTC in minutes (default +240, Oman time).

   Nothing here throws or depends on external state; an empty/unset
   schedule just means "nothing to show", not an error.
--------------------------------------------------------------- */

function parseTimes(raw) {
    return String(raw || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
}

/**
 * Seconds until the next occurrence of any of the given "HH:MM" times,
 * interpreted in utcOffsetMinutes -- or null if none are configured.
 * Always returns a value once a schedule is set, however far off.
 */
function getNextRestartSeconds(times, utcOffsetMinutes) {
    if (!times.length) return null;

    const offsetMs = utcOffsetMinutes * 60_000;
    const now = Date.now();
    const localNow = new Date(now + offsetMs);
    const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());

    let best = null;
    for (const time of times) {
        const [hours, minutes] = time.split(':').map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) continue;

        // Both today's and tomorrow's occurrence -- "now" might already be
        // past today's time, in which case only tomorrow's is still ahead.
        for (const dayOffsetMs of [0, 86_400_000]) {
            const candidateUtcMs = localMidnight + dayOffsetMs + hours * 3_600_000 + minutes * 60_000 - offsetMs;
            const secondsUntil = Math.floor((candidateUtcMs - now) / 1000);
            if (secondsUntil > 0 && (best === null || secondsUntil < best)) {
                best = secondsUntil;
            }
        }
    }
    return best;
}

/** Reads the schedule from env on every call, so an admin restart of the process is the only thing needed to pick up a change. */
function getNext() {
    const times = parseTimes(process.env.RESTART_SCHEDULE_TIMES);
    const offsetMinutes = Number.parseInt(process.env.RESTART_SCHEDULE_UTC_OFFSET_MINUTES, 10);
    return getNextRestartSeconds(times, Number.isFinite(offsetMinutes) ? offsetMinutes : 240);
}

module.exports = { getNext, getNextRestartSeconds };
