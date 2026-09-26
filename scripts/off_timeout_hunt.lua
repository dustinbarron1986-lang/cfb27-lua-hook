local TAG = "[off-timeout]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function safe_u8(address)
    local ok, value = pcall(cfb.read_u8, address)

    if ok then
        return value
    end

    return nil
end

local function read_u64(address)
    local value = 0

    for i = 7, 0, -1 do
        local b = safe_u8(address + i)

        if b == nil then
            return nil
        end

        value = value * 256 + b
    end

    return value
end

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == nil or state == 0 then
    error("off-timeout: state unavailable")
end

-- These five were stable 0 -> 1 across both post-timeout reads.
local OFFSETS = {
    0xF0,
    0x120,
    0x189,
    0x399,
    0x3C9
}

if OFF_TIMEOUT_HUNT == nil or OFF_TIMEOUT_HUNT.state ~= state then

    local candidates = {}

    log("===== BASELINE =====")
    log(string.format(
        "state=0x%X defUsed(+4140)=%s",
        state,
        tostring(safe_u8(state + 0x4140))
    ))

    for _, offset in ipairs(OFFSETS) do
        local value = safe_u8(state + offset)

        log(string.format(
            "state+0x%X = %s",
            offset,
            tostring(value)
        ))

        if value == 1 then
            candidates[#candidates + 1] = offset
        end
    end

    OFF_TIMEOUT_HUNT = {
        state = state,
        candidates = candidates,
        phase = 1
    }

    log(string.format(
        "candidates currently equal to 1 = %d",
        #candidates
    ))

    log("Call ONE offensive timeout (2 remaining -> 1 remaining), then run again.")

else

    local hunt = OFF_TIMEOUT_HUNT

    local expected

    if hunt.phase == 1 then
        expected = 2
    elseif hunt.phase == 2 then
        expected = 3
    else
        log("hunt already complete")
        return
    end

    local survivors = {}

    log(string.format(
        "===== PHASE %d EXPECT %d =====",
        hunt.phase,
        expected
    ))

    log(string.format(
        "defUsed(+4140)=%s",
        tostring(safe_u8(state + 0x4140))
    ))

    for _, offset in ipairs(hunt.candidates) do
        local value = safe_u8(state + offset)

        log(string.format(
            "CHECK state+0x%X current=%s",
            offset,
            tostring(value)
        ))

        if value == expected then
            survivors[#survivors + 1] = offset
        end
    end

    hunt.candidates = survivors

    log(string.format(
        "SURVIVORS -> %d = %d",
        expected,
        #survivors
    ))

    for i, offset in ipairs(survivors) do
        log(string.format(
            "SURVIVOR[%d] state+0x%X absolute=0x%X",
            i,
            offset,
            state + offset
        ))
    end

    if hunt.phase == 1 then
        log("Do NOT use the final timeout yet.")
    else
        log("Offensive timeout hunt complete.")
    end

    hunt.phase = hunt.phase + 1
end
