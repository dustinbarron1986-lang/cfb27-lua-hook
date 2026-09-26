local TAG = "[move-table-xref]"

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

local base = cfb.module_base()

log(string.format(
    "===== BEGIN base=0x%X =====",
    base
))

--
-- Dynamically locate QBSCRAMBLE so ASLR doesn't matter.
--
local strings = cfb.aob_scan(
    ascii_pattern("MOVESTATE_QBSCRAMBLE"),
    8
)

if #strings == 0 then
    error("QBSCRAMBLE string not found")
end

local stringAddress = strings[1]

local pointerRefs = cfb.aob_scan(
    pointer_pattern(stringAddress),
    16
)

if #pointerRefs == 0 then
    error("QBSCRAMBLE pointer-table slot not found")
end

local qbScrambleSlot = pointerRefs[1]

log(string.format(
    "QBSCRAMBLE string=0x%X slot=0x%X",
    stringAddress,
    qbScrambleSlot
))

--
-- We already know the movement names form a large sequential table.
-- Search a generous neighborhood around the QBSCRAMBLE entry.
--
local tableLow  = qbScrambleSlot - 0x300
local tableHigh = qbScrambleSlot + 0x500

log(string.format(
    "table search range 0x%X - 0x%X",
    tableLow,
    tableHigh
))

local prefixes = {
    "48",
    "4C"
}

local opcodes = {
    "8D", -- LEA
    "8B"  -- MOV
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

for _, prefix in ipairs(prefixes) do
    for _, opcode in ipairs(opcodes) do
        for _, modrm in ipairs(modrmBytes) do
            local pattern = string.format(
                "%s %s %s ?? ?? ?? ??",
                prefix,
                opcode,
                modrm
            )

            local ok, matches = pcall(
                cfb.aob_scan,
                pattern,
                256
            )

            if ok and type(matches) == "table" then
                for _, instruction in ipairs(matches) do
                    local rawDisp = read_u32le(instruction + 3)
                    local disp = signed32(rawDisp)

                    local target = instruction + 7 + disp

                    if target >= tableLow and target <= tableHigh then
                        total = total + 1

                        log(string.format(
                            "XREF instruction=0x%X target=0x%X delta_from_qb=%d opcode=%s%s",
                            instruction,
                            target,
                            target - qbScrambleSlot,
                            prefix,
                            opcode
                        ))

                        if instruction > 32 then
                            dump(instruction - 32, 80)
                        end
                    end
                end
            end
        end
    end
end

log(string.format(
    "total_table_xrefs=%d",
    total
))

log("===== END =====")