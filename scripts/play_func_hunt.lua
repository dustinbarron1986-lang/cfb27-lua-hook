local function ascii_pattern(s)
    local out = {}

    for i = 1, #s do
        out[#out + 1] = string.format("%02X", string.byte(s, i))
    end

    return table.concat(out, " ")
end

local function pointer_pattern(addr)
    local out = {}

    for i = 0, 7 do
        local b = (addr >> (i * 8)) & 0xFF
        out[#out + 1] = string.format("%02X", b)
    end

    return table.concat(out, " ")
end

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)

    if not ok then
        return nil
    end

    return value
end

local function read_u64(addr)
    local result = 0

    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)

        if b == nil then
            return nil
        end

        result = (result << 8) | b
    end

    return result
end

local targets = {
    "GETDEFPLAYGROUP",
    "GETDEFOFFSETTYPE",
    "GETOFFFORMATION",
    "GETOFFPLAYGROUP"
}

cfb.log("[play-func-hunt] BEGIN")

for _, name in ipairs(targets) do

    local pattern = ascii_pattern(name)
    local matches = cfb.aob_scan(pattern, 8)

    cfb.log(string.format(
        "[play-func-hunt] %s string_matches=%d",
        name,
        #matches
    ))

    for i, addr in ipairs(matches) do

        cfb.log(string.format(
            "[play-func-hunt] STRING %s #%d = 0x%X",
            name,
            i,
            addr
        ))

        --
        -- Search the module for an actual 64-bit pointer to this
        -- string. If this is used in a native registration table,
        -- an adjacent qword may be the function pointer we want.
        --
        local pp = pointer_pattern(addr)
        local refs = cfb.aob_scan(pp, 32)

        cfb.log(string.format(
            "[play-func-hunt] PTRREF %s count=%d",
            name,
            #refs
        ))

        for r, ref in ipairs(refs) do

            cfb.log(string.format(
                "[play-func-hunt] REF %s #%d = 0x%X",
                name,
                r,
                ref
            ))

            --
            -- Dump qwords surrounding the reference.
            --
            for off = -0x20, 0x28, 8 do
                local v = read_u64(ref + off)

                if v ~= nil then
                    cfb.log(string.format(
                        "[play-func-hunt]   %s ref%+03X = %016X",
                        name,
                        off,
                        v
                    ))
                end
            end
        end
    end
end

cfb.log("[play-func-hunt] END")
