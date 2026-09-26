local TAG = "[timeout-focus]"

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
    error("timeout-focus: TIMEOUT_DIFF baseline is missing")
end

local data = TIMEOUT_DIFF

local module = cfb.module_base()
local currentState = safe_u64(module + 0x0F2A12C8)

if currentState ~= data.state then
    error(string.format(
        "timeout-focus: state changed old=0x%X new=0x%X",
        data.state,
        currentState or 0
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

local remaining = {}
local used = {}
local flags = {}

for i, address in ipairs(data.addresses) do
    local old = data.values[i]
    local new = safe_u8(address)

    if new ~= nil then

        -- Timeout remaining:
        -- baseline had 2, current game has 1
        if old == 2 and new == 1 then
            remaining[#remaining + 1] = address
        end

        -- Timeout used:
        -- baseline had used 1, current game has used 2
        if old == 1 and new == 2 then
            used[#used + 1] = address
        end

        -- Possible boolean / bitfield side effects.
        if (old == 0 and new == 1) or
           (old == 1 and new == 0) then
            flags[#flags + 1] = {
                address = address,
                old = old,
                new = new
            }
        end
    end
end

log("===== BEGIN =====")

log(string.format(
    "state=0x%X remaining(2->1)=%d used(1->2)=%d flags=%d",
    data.state,
    #remaining,
    #used,
    #flags
))

for i, address in ipairs(remaining) do
    log(string.format(
        "REMAINING[%d] %s absolute=0x%X 2 -> 1",
        i,
        describe(address),
        address
    ))
end

for i, address in ipairs(used) do
    log(string.format(
        "USED[%d] %s absolute=0x%X 1 -> 2",
        i,
        describe(address),
        address
    ))
end

log("===== END =====")