local TAG = "[player-actor-xref]"

local function log(message)
    cfb.log(TAG .. " " .. message)
end

local function read_u16(addr)
    local b0 = cfb.read_u8(addr)
    local b1 = cfb.read_u8(addr + 1)
    return b0 + b1 * 0x100
end

local function read_u32(addr)
    local b0 = cfb.read_u8(addr)
    local b1 = cfb.read_u8(addr + 1)
    local b2 = cfb.read_u8(addr + 2)
    local b3 = cfb.read_u8(addr + 3)
    return b0
        + b1 * 0x100
        + b2 * 0x10000
        + b3 * 0x1000000
end

local function read_u64(addr)
    local lo = read_u32(addr)
    local hi = read_u32(addr + 4)
    return lo + hi * 0x100000000
end

local function hex_bytes_u32(value)
    return string.format(
        "%02X %02X %02X %02X",
        value & 0xFF,
        (value >> 8) & 0xFF,
        (value >> 16) & 0xFF,
        (value >> 24) & 0xFF
    )
end

local function hex_bytes_u64(value)
    local parts = {}
    for i = 0, 7 do
        parts[#parts + 1] = string.format("%02X", (value >> (i * 8)) & 0xFF)
    end
    return table.concat(parts, " ")
end

local function read_ascii(addr, max_len)
    local chars = {}
    for i = 0, max_len - 1 do
        local ok, b = pcall(cfb.read_u8, addr + i)
        if not ok or b == 0 then
            break
        end
        if b < 32 or b > 126 then
            return nil
        end
        chars[#chars + 1] = string.char(b)
    end
    if #chars == 0 then
        return nil
    end
    return table.concat(chars)
end

local function section_name(addr)
    local chars = {}
    for i = 0, 7 do
        local b = cfb.read_u8(addr + i)
        if b == 0 then
            break
        end
        chars[#chars + 1] = string.char(b)
    end
    return table.concat(chars)
end

local function parse_pe(base)
    if read_u16(base) ~= 0x5A4D then
        error("invalid DOS header")
    end

    local e_lfanew = read_u32(base + 0x3C)
    local nt = base + e_lfanew

    if read_u32(nt) ~= 0x00004550 then
        error("invalid PE signature")
    end

    local section_count = read_u16(nt + 0x06)
    local optional_size = read_u16(nt + 0x14)
    local optional = nt + 0x18
    local image_size = read_u32(optional + 0x38)
    local section_table = optional + optional_size
    local sections = {}

    for i = 0, section_count - 1 do
        local sh = section_table + i * 40
        local name = section_name(sh)
        local virtual_size = read_u32(sh + 0x08)
        local virtual_address = read_u32(sh + 0x0C)
        local raw_size = read_u32(sh + 0x10)
        local characteristics = read_u32(sh + 0x24)
        local span = math.max(virtual_size, raw_size)

        sections[#sections + 1] = {
            name = name,
            start = base + virtual_address,
            finish = base + virtual_address + span,
            executable = (characteristics & 0x20000000) ~= 0,
            characteristics = characteristics
        }
    end

    return image_size, sections
end

local function classify_address(addr, base, sections)
    for _, section in ipairs(sections) do
        if addr >= section.start and addr < section.finish then
            return section.name, section.executable, addr - base
        end
    end
    return "<no-section>", false, addr - base
end

local function dump_bytes(addr, before, after)
    local start_addr = addr - before
    local bytes = {}
    for i = 0, before + after - 1 do
        local ok, b = pcall(cfb.read_u8, start_addr + i)
        if ok then
            bytes[#bytes + 1] = string.format("%02X", b)
        else
            bytes[#bytes + 1] = "??"
        end
    end
    log(string.format("DUMP center=0x%X start=0x%X bytes=%s", addr, start_addr, table.concat(bytes, " ")))
end

local function scan_and_report(label, pattern, base, sections, max_hits)
    local started = os.clock()
    local hits = cfb.aob_scan(pattern, max_hits or 256)
    local elapsed = os.clock() - started
    local executable_hits = 0

    log(string.format("SCAN label=%s pattern=%s hits=%d cpu_seconds=%.3f", label, pattern, #hits, elapsed))

    for index, addr in ipairs(hits) do
        local name, executable, rva = classify_address(addr, base, sections)
        if executable then
            executable_hits = executable_hits + 1
            log(string.format(
                "EXEC_HIT label=%s index=%d addr=0x%X rva=0x%X section=%s",
                label,
                index,
                addr,
                rva,
                name
            ))
            dump_bytes(addr, 32, 64)
        elseif index <= 12 then
            log(string.format(
                "DATA_HIT label=%s index=%d addr=0x%X rva=0x%X section=%s",
                label,
                index,
                addr,
                rva,
                name
            ))
        end
    end

    log(string.format("SCAN_RESULT label=%s executable_hits=%d", label, executable_hits))
    return executable_hits, #hits
end

-- Proven in this exact build/session from actor_function_probe.lua.
local GETACTORPOSITION_STRING_RVA = 0x0B13E2C8
local GETACTORPOSITION_RECORD_RVA = 0x0B140078

local base = cfb.module_base()
local image_size, sections = parse_pe(base)
local string_addr = base + GETACTORPOSITION_STRING_RVA
local record_addr = base + GETACTORPOSITION_RECORD_RVA

log(string.format("BEGIN base=0x%X image_size=0x%X sections=%d", base, image_size, #sections))

-- Validate that the hard-known record still describes GETACTORPOSITION.
local record_name_ptr = read_u64(record_addr)
local record_name = read_ascii(record_name_ptr, 96)
local function_hash = read_u64(record_addr + 0x08)
local function_id = read_u64(record_addr + 0x10)

log(string.format(
    "RECORD addr=0x%X rva=0x%X name_ptr=0x%X expected_string=0x%X name=%s hash=0x%X id=0x%X",
    record_addr,
    GETACTORPOSITION_RECORD_RVA,
    record_name_ptr,
    string_addr,
    tostring(record_name),
    function_hash,
    function_id
))

if record_name_ptr ~= string_addr or record_name ~= "FUNCTIONKEY_GETACTORPOSITION" then
    error("GETACTORPOSITION record validation failed")
end

if function_hash ~= 0x8BD31A92 or function_id ~= 0xF5 then
    error(string.format(
        "GETACTORPOSITION key validation failed hash=0x%X id=0x%X",
        function_hash,
        function_id
    ))
end

-- First: the 32-bit hash is high-entropy and should be rare. Any copy in an
-- executable section is immediately interesting.
local hash_exec = scan_and_report(
    "GETACTORPOSITION_HASH",
    hex_bytes_u32(function_hash),
    base,
    sections,
    256
)

-- Second: look for an absolute pointer to the 24-byte metadata record. This is
-- also rare and can expose a secondary registry/dispatch structure.
local record_ptr_exec = scan_and_report(
    "GETACTORPOSITION_RECORD_PTR",
    hex_bytes_u64(record_addr),
    base,
    sections,
    128
)

-- Intentionally stop after the two discriminating scans. The standalone
-- function ID (0xF5) is too common in x64 machine code to be a useful
-- signature and previously flooded the retained log buffer with false hits.
log(string.format(
    "SUMMARY hash_exec=%d record_ptr_exec=%d",
    hash_exec,
    record_ptr_exec
))

log("END")
