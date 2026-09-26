local TAG = "[move-ptr]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function ascii_pattern(s)
    local out = {}

    for i = 1, #s do
        out[#out + 1] = string.format("%02X", string.byte(s, i))
    end

    out[#out + 1] = "00"

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

local function rva_pattern(addr, base)
    local rva = (addr - base) & 0xFFFFFFFF

    return string.format(
        "%02X %02X %02X %02X",
        rva & 0xFF,
        (rva >> 8) & 0xFF,
        (rva >> 16) & 0xFF,
        (rva >> 24) & 0xFF
    ), rva
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

local function dump_qwords(label, ref)
    for off = -0x30, 0x30, 8 do
        local value = read_u64(ref + off)

        if value ~= nil then
            log(string.format(
                "%s ref offset=%d value=%016X",
                label,
                off,
                value
            ))
        end
    end
end

local targets = {
    "MOVESTATE_SPRINT",
    "MOVESTATE_MOTION_JOG",
    "MOVESTATE_QBCONTROLLED",
    "MOVESTATE_QBROLLOUT",
    "MOVESTATE_QBSCRAMBLE",
    "MOVESTATE_QBPURSUE",
    "MOVESTATE_PASSBLOCK",
    "MOVESTATE_PASSRUSH"
}

local base = cfb.module_base()

log(string.format(
    "===== BEGIN module=0x%X =====",
    base
))

for _, name in ipairs(targets) do
    local strings = cfb.aob_scan(ascii_pattern(name), 8)

    log(string.format(
        "%s string_matches=%d",
        name,
        #strings
    ))

    for si, addr in ipairs(strings) do
        log(string.format(
            "STRING %s #%d = 0x%X",
            name,
            si,
            addr
        ))

        --
        -- Strategy 1:
        -- Search for a full 64-bit pointer to the string.
        --
        local ptrRefs = cfb.aob_scan(pointer_pattern(addr), 64)

        log(string.format(
            "PTRREF %s count=%d",
            name,
            #ptrRefs
        ))

        for ri, ref in ipairs(ptrRefs) do
            log(string.format(
                "PTR %s #%d = 0x%X",
                name,
                ri,
                ref
            ))

            dump_qwords(name .. " PTR", ref)
        end

        --
        -- Strategy 2:
        -- Some registration tables store a 32-bit RVA instead.
        --
        local rvaPat, rva = rva_pattern(addr, base)
        local rvaRefs = cfb.aob_scan(rvaPat, 64)

        log(string.format(
            "RVAREF %s rva=0x%08X count=%d",
            name,
            rva,
            #rvaRefs
        ))

        for ri, ref in ipairs(rvaRefs) do
            log(string.format(
                "RVA %s #%d = 0x%X",
                name,
                ri,
                ref
            ))

            dump_qwords(name .. " RVA", ref)
        end
    end
end

log("===== END =====")