local TAG = "[timeout-pair]"

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

local function read_u32(address)
    return
        cfb.read_u8(address) +
        cfb.read_u8(address + 1) * 0x100 +
        cfb.read_u8(address + 2) * 0x10000 +
        cfb.read_u8(address + 3) * 0x1000000
end

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == 0 then
    error("timeout-pair: state pointer is null")
end

local offUsed8 = cfb.read_u8(state + 0x1348)
local defUsed8 = cfb.read_u8(state + 0x4140)

local offUsed32 = read_u32(state + 0x1348)
local defUsed32 = read_u32(state + 0x4140)

log(string.format(
    "state=0x%X offUsed(+1348)=%d u32=%d defUsed(+4140)=%d u32=%d",
    state,
    offUsed8,
    offUsed32,
    defUsed8,
    defUsed32
))