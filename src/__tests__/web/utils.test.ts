import { UUIDT } from '../../web/utils'

test('UUIDT', async () => {
    const uuidt = new UUIDT()
    const uuidtString = uuidt.toString()
    // 32 hexadecimal digits + 4 hyphens
    expect(uuidtString).toHaveLength(36)
    // UTC timestamp matching (roughly)
    expect(uuidtString.slice(0, 8)).toEqual(Date.now().toString(16).padStart(12, '0').slice(0, 8))
    // series matching
    expect(uuidtString.slice(14, 18)).toEqual('0000')
})
