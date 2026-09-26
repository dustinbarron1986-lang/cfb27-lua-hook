local TAG = "[off-timeout-deep]"

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

local function plausible_pointer(p)
    return p ~= nil
        and p >= 0x10000
        and p < 0x0000800000000000
end

local module = cfb.module_base()
local state = safe_u64(module + 0x0F2A12C8)

if state == nil or state == 0 then
    error("off-timeout-deep: state unavailable")
end

local ROOT_RANGE    = 0x20000
local POINTER_SCAN  = 0x10000
local POINTER_RANGE = 0x200
local MAX_POINTERS  = 512

if OFF_TIMEOUT_DEEP == nil or OFF_TIMEOUT_DEEP.state ~= state then

    local addresses = {}
    local values = {}
    local pointers = {}

    local seenAddresses = {}
    local seenPointers = {}

    local function snapshot(address)
        if seenAddresses[address] then
            return
        end

        local value = safe_u8(address)

        if value ~= nil then
            seenAddresses[address] = true
            addresses[#addresses + 1] = address
            values[#values + 1] = value
        end
    end

    -- Root game-state object
    for offset = 0, ROOT_RANGE - 1 do
        snapshot(state + offset)
    end

    -- Objects referenced by the root
    for offset = 0, POINTER_SCAN - 8, 8 do
        if #pointers >= MAX_POINTERS then
            break
        end

        local p = safe_u64(state + offset)

        if plausible_pointer(p)
            and not seenPointers[p]
            and safe_u8(p) ~= nil then

            seenPointers[p] = true
            pointers[#pointers + 1] = p
        end
    end

    for _, p in ipairs(pointers) do
        for offset = 0, POINTER_RANGE - 1 do
            snapshot(p + offset)
        end
    end

    OFF_TIMEOUT_DEEP = {
        state = state,
        addresses = addresses,
        values = values,
        pointers = pointers
    }

    log("===== BASELINE =====")
    log(string.format(
        "state=0x%X rootBytes=%d pointers=%d totalBytes=%d def4140=%s",
        state,
        ROOT_RANGE,
        #pointers,
        #addresses,
        tostring(safe_u8(state + 0x4140))
    ))

    log("Baseline captured with 1 offensive timeout remaining.")
    log("Do NOT call final timeout until this baseline is confirmed.")

else

    local data = OFF_TIMEOUT_DEEP

    local function describe(address)
        if address >= data.state
            and address < data.state + ROOT_RANGE then

            return string.format(
                "state+0x%X",
                address - data.state
            )
        end

        for i, p in ipairs(data.pointers) do
            if address >= p and address < p + POINTER_RANGE then
                return string.format(
                    "ptr[%d]=0x%X +0x%X",
                    i,
                    p,
                    address - p
                )
            end
        end

        return string.format("0x%X", address)
    end

    local remaining = {}
    local used = {}
    local totalChanged = 0

    for i, address in ipairs(data.addresses) do
        local old = data.values[i]
        local new = safe_u8(address)

        if new ~= nil and new ~= old then
            totalChanged = totalChanged + 1

            if old == 1 and new == 0 then
                remaining[#remaining + 1] = address
            end

            if old == 2 and new == 3 then
                used[#used + 1] = address
            end
        end
    end

    log("===== FINAL COMPARE =====")

    log(string.format(
        "changed=%d remaining(1->0)=%d used(2->3)=%d def4140=%s",
        totalChanged,
        #remaining,
        #used,
        tostring(safe_u8(state + 0x4140))
    ))

    for i, address in ipairs(remaining) do
        log(string.format(
            "REMAINING[%d] %s absolute=0x%X",
            i,
            describe(address),
            address
        ))
    end

    for i, address in ipairs(used) do
        log(string.format(
            "USED[%d] %s absolute=0x%X",
            i,
            describe(address),
            address
        ))
    end

    log("===== END =====")
end