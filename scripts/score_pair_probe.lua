local function read_u32(addr)
    local b0 = cfb.read_u8(addr)
    local b1 = cfb.read_u8(addr + 1)
    local b2 = cfb.read_u8(addr + 2)
    local b3 = cfb.read_u8(addr + 3)

    return b0
        + b1 * 0x100
        + b2 * 0x10000
        + b3 * 0x1000000
end

local function read_u64(addr)
    local lo = read_u32(addr)
    local hi = read_u32(addr + 4)
    return lo + hi * 0x100000000
end

local state = read_u64(cfb.module_base() + 0x0F2A12C8)

cfb.log(string.format(
    "score pair probe: 0x118C=%d 0x1190=%d",
    read_u32(state + 0x118C),
    read_u32(state + 0x1190)
))
