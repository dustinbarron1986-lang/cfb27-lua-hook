local TAG = "[actor-func]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function ascii_c_pattern(s)
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

local function try_string(addr)
    if addr == nil or addr == 0 then
        return nil
    end

    local chars = {}

    for i = 0, 79 do
        local b = safe_u8(addr + i)

        if b == nil then
            return nil
        end

        if b == 0 then
            if #chars >= 4 then
                return table.concat(chars)
            end

            return nil
        end

        if b < 32 or b > 126 then
            return nil
        end

        chars[#chars + 1] = string.char(b)
    end

    return nil
end

local base = cfb.module_base()

local targets = {
    "FUNCTIONKEY_ISACTORONBEGINPLAYOFFENSE",
    "FUNCTIONKEY_ISACTORONBEGINPLAYDEFENSE",
    "FUNCTIONKEY_ISACTORVALID",
    "FUNCTIONKEY_ISACTORONHOMETEAM",
    "FUNCTIONKEY_ISACTORONAWAYTEAM",
    "FUNCTIONKEY_ISACTORONOFFENSE",
    "FUNCTIONKEY_ISACTORONDEFENSE",
    "FUNCTIONKEY_GETACTORPOSITION",
    "FUNCTIONKEY_GETACTORTEAM",
    "FUNCTIONKEY_ISACTOROUTOFBOUNDS"
}

local allRefs = {}

log(string.format(
    "===== BEGIN base=0x%X =====",
    base
))

for _, name in ipairs(targets) do
    local strings = cfb.aob_scan(
        ascii_c_pattern(name),
        8
    )

    log(string.format(
        "NAME %s string_matches=%d",
        name,
        #strings
    ))

    for _, stringAddr in ipairs(strings) do
        log(string.format(
            "STRING %s addr=0x%X",
            name,
            stringAddr
        ))

        local refs = cfb.aob_scan(
            pointer_pattern(stringAddr),
            32
        )

        log(string.format(
            "PTRREF %s count=%d",
            name,
            #refs
        ))

        for _, ref in ipairs(refs) do
            allRefs[#allRefs + 1] = {
                name = name,
                ref = ref,
                stringAddr = stringAddr
            }

            log(string.format(
                "REF %s addr=0x%X",
                name,
                ref
            ))

            --
            -- Dump a fairly wide qword neighborhood.
            --
            for off = -0x40, 0x40, 8 do
                local value = read_u64(ref + off)

                if value ~= nil then
                    local text = try_string(value)

                    if text ~= nil then
                        log(string.format(
                            "QWORD %s offset=%d value=%016X string=%s",
                            name,
                            off,
                            value,
                            text
                        ))
                    else
                        log(string.format(
                            "QWORD %s offset=%d value=%016X",
                            name,
                            off,
                            value
                        ))
                    end
                end
            end
        end
    end
end

--
-- Sort references so we can see whether these function keys
-- occupy one regular table and determine its stride.
--
table.sort(allRefs, function(a, b)
    return a.ref < b.ref
end)

log("===== SORTED REFERENCES =====")

local previous = nil

for _, item in ipairs(allRefs) do
    if previous == nil then
        log(string.format(
            "TABLE ref=0x%X name=%s",
            item.ref,
            item.name
        ))
    else
        log(string.format(
            "TABLE ref=0x%X delta=%d name=%s",
            item.ref,
            item.ref - previous.ref,
            item.name
        ))
    end

    previous = item
end

log("===== END =====")