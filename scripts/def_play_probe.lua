local MANAGER_RVA      = 0x0E19A908
local SIDE_ROOT_RVA    = 0x0F7265F0
local MAX_STRING_BYTES = 128

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)

    if not ok then
        return nil
    end

    return value
end

local function read_u32(addr)
    local b0 = safe_u8(addr)
    local b1 = safe_u8(addr + 1)
    local b2 = safe_u8(addr + 2)
    local b3 = safe_u8(addr + 3)

    if b0 == nil or b1 == nil or b2 == nil or b3 == nil then
        return nil
    end

    return b0
        + b1 * 0x100
        + b2 * 0x10000
        + b3 * 0x1000000
end

local function read_u64(addr)
    local lo = read_u32(addr)
    local hi = read_u32(addr + 4)

    if lo == nil or hi == nil then
        return nil
    end

    return lo + hi * 0x100000000
end

local function read_bounded_string(storage_addr, flag_addr)
    local flag = safe_u8(flag_addr)

    if flag == nil then
        return nil, "string flag unreadable"
    end

    local string_addr = storage_addr

    if (flag & 0x80) ~= 0 then
        string_addr = read_u64(storage_addr)

        if string_addr == nil or string_addr == 0 then
            return nil, "string pointer unavailable"
        end
    end

    local chars = {}

    for i = 0, MAX_STRING_BYTES - 1 do
        local b = safe_u8(string_addr + i)

        if b == nil then
            return nil, "string memory unreadable"
        end

        if b == 0 then
            return table.concat(chars), nil
        end

        chars[#chars + 1] = string.char(b)
    end

    return nil, "string exceeded maximum length"
end

local function stop(message)
    cfb.log("[def-play] STOP " .. message)
end

local base = cfb.module_base()

if base == nil or base == 0 then
    stop("module base unavailable")
    return
end

local manager = read_u64(base + MANAGER_RVA)

if manager == nil or manager == 0 then
    stop("manager pointer unavailable")
    return
end

local side_root = read_u64(base + SIDE_ROOT_RVA)

if side_root == nil or side_root == 0 then
    stop("side root pointer unavailable")
    return
end

local context = read_u64(side_root + 0x10)

if context == nil or context == 0 then
    stop("side context pointer unavailable")
    return
end

local current_side = read_u32(context + 0x1C8)

if current_side == nil then
    stop("current side unreadable")
    return
end

local defensive_side

if current_side == 0 then
    defensive_side = 1
elseif current_side == 1 then
    defensive_side = 0
else
    stop(string.format(
        "invalid current side=%s",
        tostring(current_side)
    ))
    return
end

local path_flag = safe_u8(manager + 0x1C90 + defensive_side)

if path_flag == nil then
    stop("manager-side path flag unreadable")
    return
end

if path_flag ~= 0 then
    stop(string.format(
        "unsupported manager-side path flag=%d side=%d",
        path_flag,
        defensive_side
    ))
    return
end

local side_object =
    manager
    + 0x10
    + defensive_side * 0xDE8

local enclosing_object = side_object + 0x08
local play_object      = enclosing_object + 0x08

local play_id = read_u32(play_object + 0x20)

if play_id == nil then
    stop("play ID unreadable")
    return
end

local play_name, play_error = read_bounded_string(
    play_object + 0x08,
    play_object + 0x17
)

if play_name == nil then
    stop("play name: " .. play_error)
    return
end

local set_name, set_error = read_bounded_string(
    enclosing_object + 0x208,
    enclosing_object + 0x217
)

if set_name == nil then
    stop("set name: " .. set_error)
    return
end

cfb.log(string.format(
    '[def-play] OK side=%d set="%s" play="%s" id=0x%08X',
    defensive_side,
    set_name,
    play_name,
    play_id & 0xFFFFFFFF
))
