local TAG = "[deer-native]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function scan(label, pattern, maxHits)
    log(string.format("SCAN %s : %s", label, pattern))

    local ok, result = pcall(cfb.aob_scan, pattern, maxHits or 32)

    if not ok then
        log(string.format("%s ERROR: %s", label, tostring(result)))
        return {}
    end

    if type(result) ~= "table" then
        log(string.format(
            "%s unexpected result type=%s value=%s",
            label,
            type(result),
            tostring(result)
        ))
        return {}
    end

    log(string.format("%s matches=%d", label, #result))

    for i, address in ipairs(result) do
        log(string.format(
            "%s[%d] = 0x%X",
            label,
            i,
            address
        ))
    end

    return result
end

local function dump(address, count)
    local out = {}

    for i = 0, count - 1 do
        local ok, value = pcall(cfb.read_u8, address + i)

        if ok then
            out[#out + 1] = string.format("%02X", value)
        else
            out[#out + 1] = "??"
        end
    end

    log(string.format(
        "DUMP 0x%X : %s",
        address,
        table.concat(out, " ")
    ))
end

local function u32_pattern(value)
    return string.format(
        "%02X %02X %02X %02X",
        value & 0xFF,
        (value >> 8) & 0xFF,
        (value >> 16) & 0xFF,
        (value >> 24) & 0xFF
    )
end

local function u64_pattern(value)
    local bytes = {}

    for i = 0, 7 do
        bytes[#bytes + 1] =
            string.format("%02X", (value >> (i * 8)) & 0xFF)
    end

    return table.concat(bytes, " ")
end

log("===== BEGIN =====")

local base = cfb.module_base()

log(string.format("module_base=0x%X", base))

-- ASCII:
-- GETOFFFORMATION\0
local stringHits = scan(
    "GETOFFFORMATION",
    "47 45 54 4F 46 46 46 4F 52 4D 41 54 49 4F 4E 00",
    16
)

local staticAddress = nil

-- The executable image is above module_base.
-- Prefer the first hit inside/above the image rather than a Lua heap copy.
for _, address in ipairs(stringHits) do
    if address >= base then
        staticAddress = address
        break
    end
end

if staticAddress == nil then
    log("No module/static GETOFFFORMATION copy identified")
else
    local rva = staticAddress - base

    log(string.format(
        "static GETOFFFORMATION=0x%X RVA=0x%X",
        staticAddress,
        rva
    ))

    -- Test #1:
    -- Is anything storing the 32-bit module-relative offset?
    local rvaPattern = u32_pattern(rva)
    local rvaHits = scan("RVA_REF", rvaPattern, 32)

    for _, address in ipairs(rvaHits) do
        -- Give us structure context around every candidate reference.
        if address >= 16 then
            dump(address - 16, 48)
        end
    end

    -- Test #2:
    -- Confirm whether anything stores the full absolute pointer.
    -- CE found zero, but this gives us an independent check.
    local absolutePattern = u64_pattern(staticAddress)
    local absoluteHits = scan("ABS_REF", absolutePattern, 16)

    for _, address in ipairs(absoluteHits) do
        if address >= 16 then
            dump(address - 16, 48)
        end
    end
end

log("===== END =====")
