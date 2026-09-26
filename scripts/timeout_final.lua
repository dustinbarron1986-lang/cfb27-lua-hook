local TAG = "[timeout-final]"

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

local function safe_u64(address)
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

if TIMEOUT_DIFF == nil then
    error("timeout-final: TIMEOUT_DIFF baseline is missing")
end

local data = TIMEOUT_DIFF

local module = cfb.module_base()
local state = safe_u64(module + 0x0F2A12C8)

if state ~= data.state then
    error(string.format(
        "timeout-final: state changed old=0x%X new=0x%X",
        data.state,
        state or 0
    ))
end

local function describe(address)
    if address >= data.state and
       address < data.state + 0x20000 then

        return string.format(
            "state+0x%X",
            address - data.state
        )
    end

    for i, p in ipairs(data.pointers) do
        if address >= p and address < p + 0x200 then
            return string.format(
                "ptr[%d]=0x%X +0x%X",
                i,
                p,
                address - p
            )
        end
    end

    return string.format("absolute=0x%X", address)
end

if TIMEOUT_FINAL == nil then
    local candidates = {}

    -- Original snapshot was when "used" appeared to be 1.
    -- Current game should now have 2 timeouts used.
    for i, address in ipairs(data.addresses) do
        local old = data.values[i]
        local current = safe_u8(address)

        if old == 1 and current == 2 then
            candidates[#candidates + 1] = address
        end
    end

    TIMEOUT_FINAL = {
        state = state,
        candidates = candidates
    }

    log("===== BASELINE =====")
    log(string.format(
        "state=0x%X candidates=%d",
        state,
        #candidates
    ))

    for i, address in ipairs(candidates) do
        log(string.format(
            "CANDIDATE[%d] %s absolute=0x%X current=2",
            i,
            describe(address),
            address
        ))
    end

    log("Call the FINAL defensive timeout, then run this script again.")

else
    if TIMEOUT_FINAL.state ~= state then
        error(string.format(
            "timeout-final: state changed old=0x%X new=0x%X",
            TIMEOUT_FINAL.state,
            state
        ))
    end

    local survivors = {}

    log("===== FINAL COMPARE =====")

    for i, address in ipairs(TIMEOUT_FINAL.candidates) do
        local current = safe_u8(address)

        log(string.format(
            "CHECK[%d] %s absolute=0x%X current=%s",
            i,
            describe(address),
            address,
            tostring(current)
        ))

        if current == 3 then
            survivors[#survivors + 1] = address
        end
    end

    log(string.format(
        "SURVIVORS 2->3 = %d",
        #survivors
    ))

    for i, address in ipairs(survivors) do
        log(string.format(
            "SURVIVOR[%d] %s absolute=0x%X",
            i,
            describe(address),
            address
        ))
    end

    log("===== END =====")
end
