import { randomBytes } from 'crypto'
import { UUID, UUIDT } from '../../ingestion/utils'

describe('UUID', () => {
    describe('#constructor', () => {
        it('works with a valid string', () => {
            const uuid = new UUID('99aBcDeF-1234-4321-0000-dcba87654321')
            expect(uuid.array).toStrictEqual(
                new Uint8Array([
                    0x99,
                    0xab,
                    0xcd,
                    0xef,
                    0x12,
                    0x34,
                    0x43,
                    0x21,
                    0,
                    0,
                    0xdc,
                    0xba,
                    0x87,
                    0x65,
                    0x43,
                    0x21,
                ])
            )
        })

        it('throws on an invalid string', () => {
            expect(() => new UUID('99aBcDeF-1234-4321-WXyz-dcba87654321')).toThrow() // "WXyz" are not hexadecimal
            expect(() => new UUID('99aBcDeF123443210000dcba87654321')).toThrow() // lack of hyphens
            expect(() => new UUID('99aBcDeF-1234-4321-0000-dcba87654321A')).toThrow() // one character too many
            expect(() => new UUID('99aBcDeF-1234-4321-0000-dcba8765432')).toThrow() // one character too few
            expect(() => new UUID('')).toThrow() // empty string
        })

        it('works with a Uint8Array', () => {
            for (let i = 0; i < 10; i++) {
                const uuid = new UUID(
                    new Uint8Array([
                        0x99,
                        0xab,
                        0xcd,
                        0xef,
                        0x12,
                        0x34,
                        0x43,
                        0x21,
                        0,
                        0,
                        0xdc,
                        0xba,
                        0x87,
                        0x65,
                        0x43,
                        0x21,
                    ])
                )
                expect(uuid.array).toStrictEqual(
                    new Uint8Array([
                        0x99,
                        0xab,
                        0xcd,
                        0xef,
                        0x12,
                        0x34,
                        0x43,
                        0x21,
                        0,
                        0,
                        0xdc,
                        0xba,
                        0x87,
                        0x65,
                        0x43,
                        0x21,
                    ])
                )
            }
        })

        it('works with a random buffer', () => {
            for (let i = 0; i < 10; i++) {
                const uuid = new UUID(randomBytes(16))
                expect(uuid.array).toHaveLength(16)
            }
        })
    })

    describe('#valueOf', () => {
        it('returns the right big integer', () => {
            const uuid = new UUID('99aBcDeF-1234-4321-0000-dcba87654321')
            expect(uuid.valueOf()).toStrictEqual(0x99abcdef123443210000dcba87654321n)
        })
    })

    describe('#toString', () => {
        it('returns the right string', () => {
            const original = '99aBcDeF-1234-4321-0000-dcba87654321'
            const uuid = new UUID(original)
            const uuidString = uuid.toString()
            // 32 hexadecimal digits + 4 hyphens
            expect(uuidString).toHaveLength(36)
            expect(uuidString).toStrictEqual(original.toLowerCase())
        })
    })
})

describe('UUIDT', () => {
    it('is well-formed', () => {
        const uuidt = new UUIDT()
        const uuidtString = uuidt.toString()
        // UTC timestamp matching (roughly, only comparing the beginning as the timestamp's end inevitably drifts away)
        expect(uuidtString.slice(0, 8)).toEqual(Date.now().toString(16).padStart(12, '0').slice(0, 8))
        // series matching
        expect(uuidtString.slice(14, 18)).toEqual('0000')
    })
})
