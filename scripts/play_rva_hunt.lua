local function ascii_c_pattern(s)
    local out = {}

    for i = 1, #s do
        out[#out + 1] = string.format("%02X", string.byte(s, i))
    end

    out[#out + 1] = "00"

    return table.concat(out, " ")
end

local function u32_pattern(v)
    return string.format(
        "%02X %02X %02X %02X",
        v & 0xFF,
        (v >> 8) & 0xFF,
        (v >> 16) & 0xFF,
        (v >> 24) & 0xFF
    )
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

local names = {
    "GETDEFPLAYGROUP",
    "GETDEFOFFSETTYPE",
    "GETOFFFORMATION",
    "GETOFFPLAYGROUP",

    -- These matter because our real goal is eventually
    -- the exact play, not merely the play group.
    "SETPLAYGROUP",
    "SETPLAY",

    "ISOFFENSIVEPLAYARUN",
    "ISOFFENSIVEPLAYAPASS"
}

local base = cfb.module_base()

cfb.log(string.format(
    "[play-rva-hunt] BEGIN module=0x%X",
    base
))

for _, name in ipairs(names) do
    local strings = cfb.aob_scan(ascii_c_pattern(name), 8)

    cfb.log(string.format(
        "[play-rva-hunt] %s strings=%d",
        name,
        #strings
    ))

    for si, addr in ipairs(strings) do
        local rva = (addr - base) & 0xFFFFFFFF
        local pat = u32_pattern(rva)

        cfb.log(string.format(
            "[play-rva-hunt] STRING %s #%d addr=0x%X rva=0x%08X pattern=%s",
            name,
            si,
            addr,
            rva,
            pat
        ))

        local refs = cfb.aob_scan(pat, 64)

        cfb.log(string.format(
            "[play-rva-hunt] RVA_REF %s count=%d",
            name,
            #refs
        ))

        for ri, ref in ipairs(refs) do
            cfb.log(string.format(
                "[play-rva-hunt] REF %s #%d addr=0x%X",
                name,
                ri,
                ref
            ))

            for off = -0x20, 0x20, 8 do
                local v = read_u64(ref + off)

                if v ~= nil then
                    cfb.log(string.format(
                        "[play-rva-hunt]   %s %+03X = %016X",
                        name,
                        off,
                        v
                    ))
                end
            end
        end
    end
end

cfb.log("[play-rva-hunt] END")
