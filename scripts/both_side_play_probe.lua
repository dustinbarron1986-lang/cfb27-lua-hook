local MANAGER_RVA      = 0x0E19A908
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

local function read_side(manager, side)
    local path_flag = safe_u8(manager + 0x1C90 + side)

    if path_flag == nil then
        cfb.log(string.format(
            "[both-side] side=%d STOP path flag unreadable",
            side
        ))
        return
    end

    if path_flag ~= 0 then
        cfb.log(string.format(
            "[both-side] side=%d STOP unsupported path flag=%d",
            side,
            path_flag
        ))
        return
    end

    local side_object =
        manager
        + 0x10
        + side * 0xDE8

    local enclosing_object = side_object + 0x08
    local play_object      = enclosing_object + 0x08

    local play_id = read_u32(play_object + 0x20)

    if play_id == nil then
        cfb.log(string.format(
            "[both-side] side=%d STOP play ID unreadable",
            side
        ))
        return
    end

    local play_name, play_error = read_bounded_string(
        play_object + 0x08,
        play_object + 0x17
    )

    if play_name == nil then
        cfb.log(string.format(
            "[both-side] side=%d STOP play name: %s",
            side,
            play_error
        ))
        return
    end

    local set_name, set_error = read_bounded_string(
        enclosing_object + 0x208,
        enclosing_object + 0x217
    )

    if set_name == nil then
        cfb.log(string.format(
            "[both-side] side=%d STOP set name: %s",
            side,
            set_error
        ))
        return
    end

    cfb.log(string.format(
        '[both-side] side=%d set="%s" play="%s" id=0x%08X',
        side,
        set_name,
        play_name,
        play_id & 0xFFFFFFFF
    ))
end

local base = cfb.module_base()

if base == nil or base == 0 then
    cfb.log("[both-side] STOP module base unavailable")
    return
end

local manager = read_u64(base + MANAGER_RVA)

if manager == nil or manager == 0 then
    cfb.log("[both-side] STOP manager pointer unavailable")
    return
end

read_side(manager, 0)
read_side(manager, 1)