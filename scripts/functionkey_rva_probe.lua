local TAG = "[functionkey-rva]"

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

local function read_u16(addr)
    local b0 = safe_u8(addr)
    local b1 = safe_u8(addr + 1)
    if b0 == nil or b1 == nil then
        return nil
    end
    return b0 | (b1 << 8)
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

local function read_u64(addr)
    local value = 0
    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)
        if b == nil then
            return nil
        end
        value = (value << 8) | b
    end
    return value
end

local function bytes4(v)
    return string.format(
        "%02X %02X %02X %02X",
        v & 0xFF,
        (v >> 8) & 0xFF,
        (v >> 16) & 0xFF,
        (v >> 24) & 0xFF
    )
end

local function section_name(raw)
    local chars = {}
    for i = 0, 7 do
        local b = safe_u8(raw + i)
        if b == nil or b == 0 then
            break
        end
        chars[#chars + 1] = string.char(b)
    end
    return table.concat(chars)
end

local base = cfb.module_base()

local mz = read_u16(base)
if mz ~= 0x5A4D then
    error("invalid DOS header")
end

local pe_off = read_u32(base + 0x3C)
local pe = base + pe_off

if read_u32(pe) ~= 0x00004550 then
    error("invalid PE signature")
end

local num_sections = read_u16(pe + 6)
local opt_size = read_u16(pe + 20)
local section_table = pe + 24 + opt_size

local sections = {}

for i = 0, num_sections - 1 do
    local sh = section_table + (i * 40)
    local name = section_name(sh)
    local virtual_size = read_u32(sh + 8) or 0
    local virtual_address = read_u32(sh + 12) or 0
    local characteristics = read_u32(sh + 36) or 0

    sections[#sections + 1] = {
        name = name,
        start = base + virtual_address,
        finish = base + virtual_address + virtual_size,
        characteristics = characteristics
    }
end

local function classify(addr)
    for _, s in ipairs(sections) do
        if addr >= s.start and addr < s.finish then
            local exec = (s.characteristics & 0x20000000) ~= 0
            return s.name, exec
        end
    end
    return "unknown", false
end

local targets = {
    {
        label = "REGISTRY_START_RVA",
        rva = 0x0B13E998
    },
    {
        label = "GETACTORPOSITION_RECORD_RVA",
        rva = 0x0B140078
    },
    {
        label = "GETACTORPOSITION_NAME_RVA",
        rva = 0x0B13E2C8
    }
}

log(string.format(
    "BEGIN base=0x%X sections=%d",
    base,
    #sections
))

for _, item in ipairs(targets) do
    local pattern = bytes4(item.rva)
    local hits = cfb.aob_scan(pattern, 128)

    log(string.format(
        "SCAN label=%s rva=0x%08X pattern=%s hits=%d",
        item.label,
        item.rva,
        pattern,
        #hits
    ))

    local exec_hits = 0

    for i, addr in ipairs(hits) do
        local sec, exec = classify(addr)

        if exec then
            exec_hits = exec_hits + 1
        end

        log(string.format(
            "HIT label=%s index=%d addr=0x%X abs_target=0x%X section=%s executable=%s",
            item.label,
            i,
            addr,
            base + item.rva,
            sec,
            tostring(exec)
        ))

        local start = addr - 24
        if start < base then
            start = base
        end
        dump(start, 64)
    end

    log(string.format(
        "SCAN_RESULT label=%s executable_hits=%d",
        item.label,
        exec_hits
    ))
end

log("END")
