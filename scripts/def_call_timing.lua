local ROOT_RVA = 0x0F2A12C8
local START = 0x0000
local SIZE  = 0x10000
local MAX_PER_GROUP = 200

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)
    if not ok then return -1 end
    return value
end

local function read_u64_le(addr)
    local value = 0
    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)
        if b < 0 then return 0 end
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

local function u32(t, off)
    local b0 = t[off]
    local b1 = t[off + 1]
    local b2 = t[off + 2]
    local b3 = t[off + 3]

    if not b0 or not b1 or not b2 or not b3 then return nil end
    if b0 < 0 or b1 < 0 or b2 < 0 or b3 < 0 then return nil end

    return (
        b0 |
        (b1 << 8) |
        (b2 << 16) |
        (b3 << 24)
    ) & 0xFFFFFFFF
end

local base = cfb.module_base()
local state = read_u64_le(base + ROOT_RVA)

if state == 0 then
    cfb.log("[def-timing] ERROR: state unavailable")
    return
end

if _G.__def_call_timing == nil or
   _G.__def_call_timing.state ~= state then

    _G.__def_call_timing = {
        state = state,
        snaps = {}
    }
end

local P = _G.__def_call_timing
local n = #P.snaps + 1

P.snaps[n] = snapshot(state)

local labels = {
    [1] = "PLAYCALL_BASELINE",
    [2] = "PLAYCALL_CONTROL",
    [3] = "AFTER_OFFENSIVE_SELECTION",
    [4] = "DEFENSE_SET_PRE_SNAP"
}

cfb.log(string.format(
    "[def-timing] SNAPSHOT %d/4 = %s",
    n,
    labels[n] or "UNKNOWN"
))

if n < 4 then
    return
end

local A = P.snaps[1]
local B = P.snaps[2]
local C = P.snaps[3]
local D = P.snaps[4]

local selection = {}
local late = {}
local transition = {}

for off = 0, SIZE - 4, 4 do
    local a = u32(A, off)
    local b = u32(B, off)
    local c = u32(C, off)
    local d = u32(D, off)

    if a and b and c and d then

        -- Stable while sitting in playcall screen.
        if a == b then

            -- Changed immediately after we selected offense,
            -- then remained stable through pre-snap.
            if b ~= c and c == d then
                table.insert(selection, {
                    off = off, a = a, c = c
                })

            -- Did not change when offense was selected,
            -- but changed once defense got aligned.
            elseif b == c and c ~= d then
                table.insert(late, {
                    off = off, a = a, d = d
                })

            -- Changed after selection AND again before snap.
            elseif b ~= c and c ~= d then
                table.insert(transition, {
                    off = off, a = a, c = c, d = d
                })
            end
        end
    end
end

cfb.log(string.format(
    "[def-timing] RESULTS selection_stable=%d late_settle=%d transition=%d",
    #selection,
    #late,
    #transition
))

cfb.log("[def-timing] === CHANGED ON PLAY SELECTION, THEN STABLE ===")

for i = 1, math.min(#selection, MAX_PER_GROUP) do
    local x = selection[i]

    cfb.log(string.format(
        "[def-timing][SELECT] +0x%04X : %08X -> %08X",
        START + x.off,
        x.a,
        x.c
    ))
end

cfb.log("[def-timing] === CHANGED ONLY WHEN DEFENSE SET ===")

for i = 1, math.min(#late, MAX_PER_GROUP) do
    local x = late[i]

    cfb.log(string.format(
        "[def-timing][LATE] +0x%04X : %08X -> %08X",
        START + x.off,
        x.a,
        x.d
    ))
end

cfb.log("[def-timing] === CHANGED DURING BOTH STAGES ===")

for i = 1, math.min(#transition, MAX_PER_GROUP) do
    local x = transition[i]

    cfb.log(string.format(
        "[def-timing][TRANS] +0x%04X : %08X -> %08X -> %08X",
        START + x.off,
        x.a,
        x.c,
        x.d
    ))
end

cfb.log("[def-timing] TEST COMPLETE -- state reset for next test")

_G.__def_call_timing = nil
