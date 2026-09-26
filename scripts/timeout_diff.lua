local TAG = "[timeout-diff]"

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
    if p == nil then
        return false
    end

    return p >= 0x10000 and
           p < 0x0000800000000000
end

local module = cfb.module_base()
local state = safe_u64(module + 0x0F2A12C8)

if state == nil or state == 0 then
    error("timeout_diff: state pointer unavailable")
end

local ROOT_RANGE       = 0x20000
local POINTER_SCAN     = 0x10000
local POINTER_RANGE    = 0x200
local MAX_POINTERS     = 512

local function describe(address, data)
    if address >= data.state and
       address < data.state + ROOT_RANGE then

        return string.format(
            "state+0x%X",
            address - data.state
        )
    end

    for i, p in ipairs(data.pointers) do
        if address >= p and
           address < p + POINTER_RANGE then

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

if TIMEOUT_DIFF == nil then

    local addresses = {}
    local values = {}
    local seenAddresses = {}

    local function snapshot_byte(address)
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

    -- Snapshot a larger portion of the known game-state object.
    for offset = 0, ROOT_RANGE - 1 do
        snapshot_byte(state + offset)
    end

    -- Find objects referenced by the game-state object.
    local pointers = {}
    local seenPointers = {}

    for offset = 0, POINTER_SCAN - 8, 8 do
        if #pointers >= MAX_POINTERS then
            break
        end

        local p = safe_u64(state + offset)

        if plausible_pointer(p) and
           not seenPointers[p] and
           safe_u8(p) ~= nil then

            seenPointers[p] = true
            pointers[#pointers + 1] = p
        end
    end

    -- Snapshot the beginning of each referenced object.
    for _, p in ipairs(pointers) do
        for offset = 0, POINTER_RANGE - 1 do
            snapshot_byte(p + offset)
        end
    end

    TIMEOUT_DIFF = {
        state = state,
        addresses = addresses,
        values = values,
        pointers = pointers
    }

    log(string.format(
        "BASELINE state=0x%X rootBytes=%d pointers=%d totalBytes=%d",
        state,
        ROOT_RANGE,
        #pointers,
        #addresses
    ))

    log("Baseline captured while defense has 2 timeouts.")
    log("Do NOT call another timeout until baseline output is checked.")

else

    local data = TIMEOUT_DIFF

    if data.state ~= state then
        log(string.format(
            "STATE CHANGED old=0x%X new=0x%X -- baseline discarded",
            data.state,
            state
        ))

        TIMEOUT_DIFF = nil
        return
    end

    local changed = 0
    local interesting = {}

    for i, address in ipairs(data.addresses) do
        local old = data.values[i]
        local new = safe_u8(address)

        if new ~= nil and new ~= old then
            changed = changed + 1

            -- Timeout storage is likely to involve very small values.
            -- This catches 3->2, 2->1, 0->1, 1->2, bitfield-ish
            -- transitions, etc.
            if old <= 7 and new <= 7 then
                interesting[#interesting + 1] = {
                    address = address,
                    old = old,
                    new = new
                }
            end
        end
    end

    log(string.format(
        "COMPARE changedBytes=%d smallValueChanges=%d",
        changed,
        #interesting
    ))

    for i = 1, math.min(#interesting, 200) do
        local hit = interesting[i]

        log(string.format(
            "candidate[%d] %s absolute=0x%X %d -> %d",
            i,
            describe(hit.address, data),
            hit.address,
            hit.old,
            hit.new
        ))
    end

    if #interesting > 200 then
        log(string.format(
            "... plus %d additional small-value changes",
            #interesting - 200
        ))
    end

    log("Comparison complete.")
end