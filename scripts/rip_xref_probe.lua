local TAG = "[rip-xref]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function read_u32le(address)
    local b0 = cfb.read_u8(address)
    local b1 = cfb.read_u8(address + 1)
    local b2 = cfb.read_u8(address + 2)
    local b3 = cfb.read_u8(address + 3)

    return b0
        + b1 * 0x100
        + b2 * 0x10000
        + b3 * 0x1000000
end

local function signed32(value)
    if value >= 0x80000000 then
        return value - 0x100000000
    end

    return value
end

local function dump(address, count)
    local bytes = {}

    for i = 0, count - 1 do
        local ok, value = pcall(cfb.read_u8, address + i)

        if ok then
            bytes[#bytes + 1] = string.format("%02X", value)
        else
            bytes[#bytes + 1] = "??"
        end
    end

    log(string.format(
        "DUMP 0x%X : %s",
        address,
        table.concat(bytes, " ")
    ))
end

local function scan_pattern(pattern, targetBase)
    local ok, matches = pcall(cfb.aob_scan, pattern, 4096)

    if not ok then
        log("SCAN ERROR " .. pattern .. " : " .. tostring(matches))
        return
    end

    if type(matches) ~= "table" then
        return
    end

    for _, address in ipairs(matches) do
        -- LEA RIP-relative is 7 bytes:
        -- REX 8D ModRM disp32
        local rawDisp = read_u32le(address + 3)
        local disp = signed32(rawDisp)

        local target = address + 7 + disp

        -- Exact GETOFFFORMATION hit
        if target == targetBase then
            log(string.format(
                "EXACT xref instruction=0x%X target=0x%X pattern=%s",
                address,
                target,
                pattern
            ))

            if address >= 24 then
                dump(address - 24, 64)
            end
        end

        -- Also show references into the surrounding API-name pool.
        if target >= (targetBase - 0x400)
            and target <= (targetBase + 0x2000) then

            log(string.format(
                "POOL xref instruction=0x%X target=0x%X delta=%+d pattern=%s",
                address,
                target,
                target - targetBase,
                pattern
            ))
        end
    end
end

log("===== BEGIN =====")

local base = cfb.module_base()
local target = base + 0x0B69CF90

log(string.format(
    "module_base=0x%X target=0x%X",
    base,
    target
))

-- RIP-relative LEA uses ModRM r/m=101.
-- These cover destination registers RAX-R15.
local rexPrefixes = {
    "48",
    "4C"
}

local modrmBytes = {
    "05",
    "0D",
    "15",
    "1D",
    "25",
    "2D",
    "35",
    "3D"
}

for _, rex in ipairs(rexPrefixes) do
    for _, modrm in ipairs(modrmBytes) do
        local pattern = string.format(
            "%s 8D %s ?? ?? ?? ??",
            rex,
            modrm
        )

        scan_pattern(pattern, target)
    end
end

log("===== END =====")