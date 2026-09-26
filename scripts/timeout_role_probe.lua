local TAG = "[timeout-role]"

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

local function safe_u8(address)
    local ok, value = pcall(cfb.read_u8, address)

    if ok then
        return value
    end

    return nil
end

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == 0 then
    error("timeout-role: state pointer is null")
end

local RANGE = 0x10000

if TIMEOUT_ROLE_PROBE == nil or TIMEOUT_ROLE_PROBE.state ~= state then

    local values = {}

    for offset = 0, RANGE - 1 do
        values[offset] = safe_u8(state + offset)
    end

    TIMEOUT_ROLE_PROBE = {
        state = state,
        values = values
    }

    log("===== OFFENSE BASELINE =====")
    log(string.format(
        "state=0x%X known4140=%s",
        state,
        tostring(safe_u8(state + 0x4140))
    ))

    log("Baseline captured with 3 offensive timeouts.")
    log("Call ONE offensive timeout, then run again.")

else

    local data = TIMEOUT_ROLE_PROBE

    local usedHits = {}
    local remainingHits = {}

    for offset = 0, RANGE - 1 do
        local old = data.values[offset]
        local new = safe_u8(state + offset)

        if old ~= nil and new ~= nil then

            -- possible "timeouts used"
            if old == 0 and new == 1 then
                usedHits[#usedHits + 1] = offset
            end

            -- possible "timeouts remaining"
            if old == 3 and new == 2 then
                remainingHits[#remainingHits + 1] = offset
            end
        end
    end

    log("===== OFFENSE COMPARE =====")

    log(string.format(
        "known4140=%s used(0->1)=%d remaining(3->2)=%d",
        tostring(safe_u8(state + 0x4140)),
        #usedHits,
        #remainingHits
    ))

    for i, offset in ipairs(usedHits) do
        if i > 100 then break end

        log(string.format(
            "USED[%d] state+0x%X absolute=0x%X",
            i,
            offset,
            state + offset
        ))
    end

    for i, offset in ipairs(remainingHits) do
        if i > 100 then break end

        log(string.format(
            "REMAINING[%d] state+0x%X absolute=0x%X",
            i,
            offset,
            state + offset
        ))
    end

    log("===== END =====")
end
