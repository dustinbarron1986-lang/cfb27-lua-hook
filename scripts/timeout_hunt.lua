local TAG = "[timeout-hunt]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function read_u64(address)
    local value = 0

    for i = 7, 0, -1 do
        value = value * 256 + cfb.read_u8(address + i)
    end

    return value
end

local function safe_read(address)
    local ok, value = pcall(cfb.read_u8, address)

    if ok then
        return value
    end

    return nil
end

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == 0 then
    error("timeout_hunt: state pointer is null")
end

-- Search first 64 KB of the live game-state object.
local RANGE = 0x10000

if TIMEOUT_HUNT_321 == nil then
    local candidates = {}

    for offset = 0, RANGE - 1 do
        local value = safe_read(state + offset)

        -- You currently have THREE defensive timeouts.
        if value == 3 then
            candidates[#candidates + 1] = offset
        end
    end

    TIMEOUT_HUNT_321 = {
        state = state,
        candidates = candidates,
        phase = 1
    }

    log(string.format(
        "BASELINE state=0x%X range=0x0..0x%X candidates=%d",
        state,
        RANGE - 1,
        #candidates
    ))

    log("Baseline is 3 timeouts. Call ONE defensive timeout, then run again.")

else
    if TIMEOUT_HUNT_321.state ~= state then
        log(string.format(
            "STATE CHANGED old=0x%X new=0x%X -- hunt reset",
            TIMEOUT_HUNT_321.state,
            state
        ))

        TIMEOUT_HUNT_321 = nil
        return
    end

    local expected

    if TIMEOUT_HUNT_321.phase == 1 then
        expected = 2
    elseif TIMEOUT_HUNT_321.phase == 2 then
        expected = 1
    else
        log("3 -> 2 -> 1 hunt is already complete.")
        return
    end

    local survivors = {}

    for _, offset in ipairs(TIMEOUT_HUNT_321.candidates) do
        local value = safe_read(state + offset)

        if value == expected then
            survivors[#survivors + 1] = offset
        end
    end

    TIMEOUT_HUNT_321.candidates = survivors

    log(string.format(
        "PHASE %d expected=%d survivors=%d",
        TIMEOUT_HUNT_321.phase,
        expected,
        #survivors
    ))

    for i = 1, math.min(#survivors, 100) do
        log(string.format(
            "candidate[%d] state+0x%X absolute=0x%X",
            i,
            survivors[i],
            state + survivors[i]
        ))
    end

    if #survivors > 100 then
        log(string.format(
            "... plus %d more",
            #survivors - 100
        ))
    end

    if TIMEOUT_HUNT_321.phase == 1 then
        log("Now at 2 timeouts. Call ONE more defensive timeout, then run again.")
    else
        log("3 -> 2 -> 1 filtering complete. Do NOT use the final timeout yet.")
    end

    TIMEOUT_HUNT_321.phase = TIMEOUT_HUNT_321.phase + 1
end