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

local function read_f32(addr)
    local bits = read_u32(addr)

    local sign = 1
    if bits >= 0x80000000 then
        sign = -1
        bits = bits - 0x80000000
    end

    local exponent = math.floor(bits / 0x800000)
    local mantissa = bits % 0x800000

    if exponent == 255 then
        return 0/0
    elseif exponent == 0 then
        return sign * (mantissa / 0x800000) * (2 ^ -126)
    end

    return sign
        * (1 + mantissa / 0x800000)
        * (2 ^ (exponent - 127))
end

local ok, err = pcall(function()
    local module = cfb.module_base()
    local state = read_u64(module + 0x0F2A12C8)

    local gameClock  = read_u32(state + 0x1184)
    local playClock  = read_u32(state + 0x1188)
    local quarter    = read_u32(state + 0x1194)
    local possession = read_u32(state + 0x1198)
    local down       = read_u32(state + 0x119C)
    local distance   = read_u32(state + 0x11A0)

    local fieldY     = read_f32(state + 0x1A18)
    local fieldX     = read_f32(state + 0x1A1C)
    local lineToGain = read_f32(state + 0x1A70)

    cfb.emit("coord.state", {
        gameClockSeconds = gameClock,
        playClockSeconds = playClock,
        quarter = quarter,
        possession = possession,
        down = down,
        distance = distance,
        fieldX = fieldX,
        fieldY = fieldY,
        lineToGain = lineToGain
    })

    cfb.log("coord.state emitted")
end)

if not ok then
    cfb.log("coord state emit FAILED: " .. tostring(err))
end
