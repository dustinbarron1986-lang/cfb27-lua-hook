local TAG = "[move-xref]"

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

log("===== BEGIN =====")

local base = cfb.module_base()

local targets = {
    { name = "MOTION_JOG",    rva = 0x0B69E438 },
    { name = "QBCONTROLLED",  rva = 0x0B69E4B8 },
    { name = "QBROLLOUT",     rva = 0x0B69E4D0 },
    { name = "QBSCRAMBLE",    rva = 0x0B69E4E8 },
    { name = "QBPURSUE",      rva = 0x0B69E500 },
    { name = "PASSBLOCK",     rva = 0x0B69E570 },
    { name = "PASSRUSH",      rva = 0x0B69E588 },
}

for _, item in ipairs(targets) do
    item.address = base + item.rva

    log(string.format(
        "TARGET %-14s 0x%X",
        item.name,
        item.address
    ))
end

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

local total = 0

for _, rex in ipairs(rexPrefixes) do
    for _, modrm in ipairs(modrmBytes) do
        local pattern = string.format(
            "%s 8D %s ?? ?? ?? ??",
            rex,
            modrm
        )

        local ok, matches = pcall(cfb.aob_scan, pattern, 8192)

        if ok and type(matches) == "table" then
            for _, instruction in ipairs(matches) do
                local okRead, rawDisp = pcall(
                    read_u32le,
                    instruction + 3
                )

                if okRead then
                    local disp = signed32(rawDisp)
                    local target = instruction + 7 + disp

                    for _, item in ipairs(targets) do
                        if target == item.address then
                            total = total + 1

                            log(string.format(
                                "XREF %-14s instruction=0x%X target=0x%X pattern=%s",
                                item.name,
                                instruction,
                                target,
                                pattern
                            ))

                            if instruction >= 32 then
                                dump(instruction - 32, 80)
                            end
                        end
                    end
                end
            end
        end
    end
end

log(string.format("total_xrefs=%d", total))
log("===== END =====")
