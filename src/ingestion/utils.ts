import { randomBytes } from 'crypto'
import { DateTime } from 'luxon'

/** LUT of byte value to hexadecimal representation. For UUID stringification. */
const byteToHex: string[] = []
for (let i = 0; i < 256; i++) {
    byteToHex.push((i + 0x100).toString(16).substr(1))
}

export class UUID {
    static validateString(candidate: string): void {
        if (!candidate.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i)) {
            throw new Error(
                'String does not match format XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX (where each X is a hexadecimal character)!'
            )
        }
    }

    array: Uint8Array

    constructor(candidate: string | Uint8Array | Buffer) {
        if (candidate instanceof Uint8Array) {
            if (candidate.byteLength !== 16) {
                throw new Error(`UUID must be built from exactly 16 bytes, but you provided ${candidate.byteLength}!`)
            }
            this.array = new Uint8Array(candidate)
        } else {
            candidate = candidate.trim()
            UUID.validateString(candidate)
            this.array = new Uint8Array(16)
            const characters = Array.from(candidate).filter((character) => character !== '-')
            for (let i = 0; i < characters.length; i += 2) {
                this.array[i / 2] = parseInt(characters[i] + characters[i + 1], 16)
            }
        }
    }

    /** Convert to 128-bit BigInt. */
    valueOf(): BigInt {
        let value = 0n
        for (const byte of this.array) {
            value <<= 8n
            value += BigInt(byte)
        }
        return value
    }

    /**
     * Convert to string format of the form:
     * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
     * Adapted from https://github.com/uuidjs/uuid/blob/master/src/stringify.js
     */
    toString(): string {
        // Note: Be careful editing this code! It's been tuned for performance and works in ways you may not expect.
        // See https://github.com/uuidjs/uuid/pull/434
        const arr = this.array
        return (
            byteToHex[arr[0]] +
            byteToHex[arr[1]] +
            byteToHex[arr[2]] +
            byteToHex[arr[3]] +
            '-' +
            byteToHex[arr[4]] +
            byteToHex[arr[5]] +
            '-' +
            byteToHex[arr[6]] +
            byteToHex[arr[7]] +
            '-' +
            byteToHex[arr[8]] +
            byteToHex[arr[9]] +
            '-' +
            byteToHex[arr[10]] +
            byteToHex[arr[11]] +
            byteToHex[arr[12]] +
            byteToHex[arr[13]] +
            byteToHex[arr[14]] +
            byteToHex[arr[15]]
        ).toLowerCase()
    }
}

/**
 * UUID (mostly) sortable by generation time.
 *
 * This doesn't adhere to any official UUID version spec, but it is superior as a primary key:
 * to incremented integers (as they can reveal sensitive business information about usage volumes and patterns),
 * to UUID v4 (as the complete randomness of v4 makes its indexing performance suboptimal),
 * and to UUID v1 (as despite being time-based it can't be used practically for sorting by generation time).
 *
 * Order can be messed up if system Unix time is changed or if more than 65 536 IDs are generated per millisecond
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
export class UUIDT extends UUID {
    static currentSeriesPerMs: Map<number, number> = new Map()

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

    constructor(unixTimeMs?: number) {
        if (!unixTimeMs) {
            unixTimeMs = DateTime.utc().toMillis()
        }
        let unixTimeMsBig = BigInt(unixTimeMs)
        let series = UUIDT.getSeries(unixTimeMs)
        // 64 bits (8 bytes) total
        const array = new Uint8Array(16)
        // 48 bits for time, WILL FAIL in 10 895 CE
        // XXXXXXXX-XXXX-****-****-************
        for (let i = 5; i >= 0; i--) {
            array[i] = Number(unixTimeMsBig & 0xffn) // use last 8 binary digits to set UUID 2 hexadecimal digits
            unixTimeMsBig >>= 8n // remove these last 8 binary digits
        }
        // 16 bits for series
        // ********-****-XXXX-****-************
        for (let i = 7; i >= 6; i--) {
            array[i] = series & 0xff // use last 8 binary digits to set UUID 2 hexadecimal digits
            series >>>= 8 // remove these last 8 binary digits
        }
        // 64 bits for random gibberish
        // ********-****-****-XXXX-XXXXXXXXXXXX
        array.set(randomBytes(8), 8)
        super(array)
    }
}

/** Simplistic Python `not` equivalent. */
export function isLooselyFalsy(value: any): boolean {
    return Array.isArray(value) ? !value.length : !value || !Object.keys(value).length
}

export function castTimestampOrNow(timestamp?: DateTime | string | null): string {
    if (!timestamp) {
        timestamp = DateTime.utc()
    }

    // ClickHouse specific formatting
    timestamp = typeof timestamp === 'string' ? DateTime.fromISO(timestamp) : timestamp.toUTC()

    return timestamp.toFormat('yyyy-MM-dd HH:mm:ss.u')
}
