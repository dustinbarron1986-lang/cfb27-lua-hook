local TAG = "[timeout-reader]"

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

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == 0 then
    error("timeout-reader: state pointer is null")
end

local used = cfb.read_u8(state + 0x4140)

local remaining = nil

if used >= 0 and used <= 3 then
    remaining = 3 - used
end

log(string.format(
    "state=0x%X timeoutUsed=%d timeoutRemaining=%s",
    state,
    used,
    tostring(remaining)
))
