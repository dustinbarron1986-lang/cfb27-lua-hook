local ROOT_RVA = 0x0F2A12C8

-- Large enough to explore well beyond our known clock/down block.
local START = 0x0000
local SIZE  = 0x8000

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)
    if not ok then
        return -1
    end
    return value
end

local function read_u64_le(addr)
    local value = 0

    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)
        if b < 0 then
            return 0
        end

        value = (value << 8) | b
    end

    return value
end

local function snapshot(state)
    local t = {}

    for i = 0, SIZE - 1 do
        t[i] = safe_u8(state + START + i)
    end

    return t
end

local function u32_from(t, off)
    if
        t[off] == nil or
        t[off + 1] == nil or
        t[off + 2] == nil or
        t[off + 3] == nil or
        t[off] < 0 or
        t[off + 1] < 0 or
        t[off + 2] < 0 or
        t[off + 3] < 0
    then
        return nil
    end

    return
        t[off] |
        (t[off + 1] << 8) |
        (t[off + 2] << 16) |
        (t[off + 3] << 24)
end

local base = cfb.module_base()
local state = read_u64_le(base + ROOT_RVA)

if state == 0 then
    cfb.log("[play-probe] state pointer unavailable")
    return
end

local current = snapshot(state)

if
    _G.__coord_play_probe == nil or
    _G.__coord_play_probe.state ~= state
then
    _G.__coord_play_probe = {
        state = state,
        bytes = current,
        number = 1
    }

    cfb.log("[play-probe] SNAPSHOT 1 BASELINE SAVED")
    return
end

local previous = _G.__coord_play_probe.bytes
local number = (_G.__coord_play_probe.number or 1) + 1

local seen = {}
local changes = 0

cfb.log(string.format(
    "[play-probe] SNAPSHOT %d DIFF BEGIN",
    number
))

for i = 0, SIZE - 1 do
    if previous[i] ~= current[i] then

        -- Collapse byte changes into aligned DWORDs so an integer/pointer
        -- doesn't appear four separate times.
        local aligned = i - (i % 4)

        if not seen[aligned] then
            seen[aligned] = true

            local oldv = u32_from(previous, aligned)
            local newv = u32_from(current, aligned)

            if oldv ~= nil and newv ~= nil then
                cfb.log(string.format(
                    "[play-probe] +0x%04X : %08X -> %08X (%u -> %u)",
                    START + aligned,
                    oldv & 0xFFFFFFFF,
                    newv & 0xFFFFFFFF,
                    oldv & 0xFFFFFFFF,
                    newv & 0xFFFFFFFF
                ))

                changes = changes + 1
            end
        end
    end
end

cfb.log(string.format(
    "[play-probe] SNAPSHOT %d DIFF END changes=%d",
    number,
    changes
))

_G.__coord_play_probe = {
    state = state,
    bytes = current,
    number = number
}