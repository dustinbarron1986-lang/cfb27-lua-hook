local TAG = "[functionkey-table-xref]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

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
        | (b1 << 8)
        | (b2 << 16)
        | (b3 << 24)
end

local function signed32(v)
    if v >= 0x80000000 then
        return v - 0x100000000
    end
    return v
end

local function dump(addr, count)
    local out = {}

    for i = 0, count - 1 do
        local b = safe_u8(addr + i)
        if b == nil then
            out[#out + 1] = "??"
        else
            out[#out + 1] = string.format("%02X", b)
        end
    end

    log(string.format(
        "DUMP start=0x%X bytes=%s",
        addr,
        table.concat(out, " ")
    ))
end

local base = cfb.module_base()

-- Proven FUNCTIONKEY table bounds from the prior registry probe.
local table_start = 0x14B13E998
local table_end_exclusive = 0x14B141E60
local stride = 24

log(string.format(
    "BEGIN base=0x%X table_start=0x%X table_end=0x%X stride=%d",
    base,
    table_start,
    table_end_exclusive,
    stride
))

local patterns = {}

-- Common RIP-relative LEA / MOV forms:
--   REX.W + 8D/8B + modrm(00 r/m=101) + disp32
-- ModRM low 3 bits must be 101 for RIP-relative addressing.
for _, rex in ipairs({ "48", "4C" }) do
    for _, opcode in ipairs({ "8D", "8B" }) do
        for reg = 0, 7 do
            local modrm = (reg << 3) | 0x05
            patterns[#patterns + 1] = {
                label = string.format("%s_%s_%02X", rex, opcode, modrm),
                pattern = string.format(
                    "%s %s %02X ?? ?? ?? ??",
                    rex,
                    opcode,
                    modrm
                )
            }
        end
    end
end

local seen = {}
local total_hits = 0

for _, item in ipairs(patterns) do
    local ok, hits = pcall(cfb.aob_scan, item.pattern, 512)

    if not ok then
        log(string.format(
            "SCAN_ERROR label=%s error=%s",
            item.label,
            tostring(hits)
        ))
    else
        for _, insn in ipairs(hits) do
            local disp_raw = read_u32(insn + 3)

            if disp_raw ~= nil then
                local disp = signed32(disp_raw)
                local target = insn + 7 + disp

                if target >= table_start and target < table_end_exclusive then
                    local key = string.format("%X", insn)

                    if not seen[key] then
                        seen[key] = true
                        total_hits = total_hits + 1

                        local offset = target - table_start
                        local record_index = offset // stride
                        local within_record = offset % stride

                        log(string.format(
                            "XREF index=%d insn=0x%X target=0x%X offset=0x%X record_index=%d within_record=%d pattern=%s",
                            total_hits,
                            insn,
                            target,
                            offset,
                            record_index,
                            within_record,
                            item.label
                        ))

                        local dump_start = insn - 32
                        if dump_start < base then
                            dump_start = base
                        end

                        dump(dump_start, 80)
                    end
                end
            end
        end
    end
end

log(string.format(
    "SUMMARY total_xrefs=%d",
    total_hits
))

log("END")
