import { stringify as uuidStringify } from 'uuid'

/**
 * UUID (mostly) sortable by generation time.
 *
 * This doesn't adhere to any official UUID version spec, but it is superior as a primary key:
 * to incremented integers (as they can reveal sensitive business information about usage volumes and patterns),
 * to UUID v4 (as the complete randomness of v4 makes its indexing performance suboptimal),
 * and to UUID v1 (as despite being time-based it can't be used practically for sorting by generation time).
 *
 * Order can be messed up if system clock is changed or if more than 65 536 IDs are generated per millisecond
 * (that's over 5 trillion events per day), but it should be largely safe to assume that these are time-sortable.
 *
 * Anatomy:
 * - 6 bytes - Unix time milliseconds unsigned integer
 * - 2 bytes - autoincremented series unsigned integer (per millisecond, rolls over to 0 after reaching 65 535 UUIDs in one ms)
 * - 8 bytes - securely random gibberish
 *
 * Loosely based on [Segment's KSUID](https://github.com/segmentio/ksuid) and
 * on [Twitter's snowflake ID](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake.html).
 * Ported from the PostHog Django app.
 */
export class UUIDT {
    static currentSeriesPerMs: Map<number, number> = new Map()
    static crypto = new Crypto()

    /** Get per-millisecond series integer in range [0-65536). */
    static getSeries(unixTimeMs: number): number {
        const series = UUIDT.currentSeriesPerMs.get(unixTimeMs)
        if (UUIDT.currentSeriesPerMs.size > 10_000) {
            // Clear class dict periodically
            UUIDT.currentSeriesPerMs.clear()
        }
        const nextSeries = typeof series === 'number' ? (series + 1) % 65_536 : 0
        UUIDT.currentSeriesPerMs.set(unixTimeMs, nextSeries)
        return nextSeries
    }

    array: Uint8Array

    constructor(unixTimeMs?: number) {
        if (!unixTimeMs) {
            unixTimeMs = Date.now()
        }

        this.array = new Uint8Array(16)
        // 48 bits for time, WILL FAIL in 10 895 CE
        let shiftedUnixTimeMs = unixTimeMs
        for (let i = 5; i >= 0; i--) {
            this.array[i] = shiftedUnixTimeMs & 0b11111111 // use last 8 binary digits
            shiftedUnixTimeMs >>= 8 // remove these last 8 binary digits
        }
        // 16 bits for series
        let series = UUIDT.getSeries(unixTimeMs)
        for (let i = 7; i >= 6; i--) {
            this.array[i] = series & 0b11111111 // use last 8 binary digits
            series >>= 8 // remove these last 8 binary digits
        }
        // 64 bits for random gibberish
        this.array.set(UUIDT.crypto.getRandomValues(new Uint32Array(2)), 8)
    }

    toNumber(): number {
        let value = 0
        for (const byte of this.array) {
            value <<= 8
            value += byte
        }
        return value
    }

    toString(): string {
        return uuidStringify(this.array)
    }
}
