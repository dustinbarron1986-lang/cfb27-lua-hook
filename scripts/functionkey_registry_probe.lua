local TAG = "[functionkey-registry]"

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
        out[#out + 1] = string.format(
            "%02X",
            (addr >> (i * 8)) & 0xFF
        )
    end

    return table.concat(out, " ")
end

local function try_ascii(addr, max_len)
    if addr == nil or addr == 0 then
        return nil
    end

    local chars = {}
    max_len = max_len or 128

    for i = 0, max_len - 1 do
        local b = safe_u8(addr + i)

        if b == nil then
            return nil
        end

        if b == 0 then
            if #chars == 0 then
                return nil
            end
            return table.concat(chars)
        end

        if b < 32 or b > 126 then
            return nil
        end

        chars[#chars + 1] = string.char(b)
    end

    return nil
end

local function is_functionkey_string(ptr)
    local s = try_ascii(ptr, 96)
    if s == nil then
        return false, nil
    end

    if string.sub(s, 1, 12) ~= "FUNCTIONKEY_" then
        return false, s
    end

    return true, s
end

local function record_at(addr)
    local name_ptr = read_u64(addr)
    local hash64   = read_u64(addr + 8)
    local id64     = read_u64(addr + 16)

    if name_ptr == nil or hash64 == nil or id64 == nil then
        return nil
    end

    local ok_name, name = is_functionkey_string(name_ptr)
    if not ok_name then
        return nil
    end

    -- Known records use a 32-bit hash in qword slot 2 and a small numeric ID
    -- in qword slot 3. Keep validation permissive enough to survive gaps.
    local hash_hi = (hash64 >> 32) & 0xFFFFFFFF
    if hash_hi ~= 0 then
        return nil
    end

    if id64 > 0x100000 then
        return nil
    end

    return {
        addr = addr,
        name_ptr = name_ptr,
        name = name,
        hash = hash64 & 0xFFFFFFFF,
        id = id64
    }
end

local function scan_exact_pointer(label, addr)
    local hits = cfb.aob_scan(pointer_pattern(addr), 128)

    log(string.format(
        "PTR_SCAN label=%s target=0x%X hits=%d",
        label,
        addr,
        #hits
    ))

    for i, hit in ipairs(hits) do
        log(string.format(
            "PTR_HIT label=%s index=%d addr=0x%X",
            label,
            i,
            hit
        ))

        for off = -32, 32, 8 do
            local q = read_u64(hit + off)
            if q ~= nil then
                log(string.format(
                    "  QWORD offset=%d value=0x%X",
                    off,
                    q
                ))
            end
        end
    end

    return hits
end

local function scan_pair(label, a, b)
    local pattern = pointer_pattern(a) .. " " .. pointer_pattern(b)
    local hits = cfb.aob_scan(pattern, 64)

    log(string.format(
        "PAIR_SCAN label=%s hits=%d",
        label,
        #hits
    ))

    for i, hit in ipairs(hits) do
        log(string.format(
            "PAIR_HIT label=%s index=%d addr=0x%X",
            label,
            i,
            hit
        ))

        for off = -32, 48, 8 do
            local q = read_u64(hit + off)
            if q ~= nil then
                log(string.format(
                    "  QWORD offset=%d value=0x%X",
                    off,
                    q
                ))
            end
        end
    end

    return hits
end

local base = cfb.module_base()

log(string.format(
    "BEGIN base=0x%X",
    base
))

local strings = cfb.aob_scan(
    ascii_c_pattern("FUNCTIONKEY_GETACTORPOSITION"),
    8
)

if #strings == 0 then
    error("FUNCTIONKEY_GETACTORPOSITION string not found")
end

local target_string = strings[1]

local refs = cfb.aob_scan(
    pointer_pattern(target_string),
    16
)

if #refs == 0 then
    error("GETACTORPOSITION metadata record not found")
end

local target_record = nil

for _, ref in ipairs(refs) do
    local rec = record_at(ref)
    if rec ~= nil and rec.name == "FUNCTIONKEY_GETACTORPOSITION" then
        target_record = rec
        break
    end
end

if target_record == nil then
    error("GETACTORPOSITION pointer reference was not a valid 24-byte FUNCTIONKEY record")
end

log(string.format(
    "TARGET record=0x%X name_ptr=0x%X hash=0x%08X id=%d",
    target_record.addr,
    target_record.name_ptr,
    target_record.hash,
    target_record.id
))

local stride = 24
local records = {
    [target_record.addr] = target_record
}

local start_addr = target_record.addr
local end_addr = target_record.addr

-- Walk backward through contiguous valid records.
local cursor = target_record.addr - stride
local backward_count = 0

while backward_count < 2048 do
    local rec = record_at(cursor)
    if rec == nil then
        break
    end

    records[cursor] = rec
    start_addr = cursor
    backward_count = backward_count + 1
    cursor = cursor - stride
end

-- Walk forward through contiguous valid records.
cursor = target_record.addr + stride
local forward_count = 0

while forward_count < 2048 do
    local rec = record_at(cursor)
    if rec == nil then
        break
    end

    records[cursor] = rec
    end_addr = cursor
    forward_count = forward_count + 1
    cursor = cursor + stride
end

local count = ((end_addr - start_addr) // stride) + 1
local end_exclusive = end_addr + stride
local target_index = (target_record.addr - start_addr) // stride

log(string.format(
    "REGISTRY start=0x%X end_record=0x%X end_exclusive=0x%X count=%d target_index=%d",
    start_addr,
    end_addr,
    end_exclusive,
    count,
    target_index
))

local first = records[start_addr]
local last = records[end_addr]

if first ~= nil then
    log(string.format(
        "FIRST addr=0x%X name=%s hash=0x%08X id=%d",
        first.addr,
        first.name,
        first.hash,
        first.id
    ))
end

if last ~= nil then
    log(string.format(
        "LAST addr=0x%X name=%s hash=0x%08X id=%d",
        last.addr,
        last.name,
        last.hash,
        last.id
    ))
end

-- Sample around GETACTORPOSITION so we can validate ordering and IDs.
for rel = -3, 3 do
    local addr = target_record.addr + (rel * stride)
    local rec = records[addr]

    if rec ~= nil then
        log(string.format(
            "NEAR rel=%d addr=0x%X name=%s hash=0x%08X id=%d",
            rel,
            rec.addr,
            rec.name,
            rec.hash,
            rec.id
        ))
    end
end

-- Exact pointer searches only. These are native AOB scans, not Lua bytewise walks.
local start_hits = scan_exact_pointer("REGISTRY_START", start_addr)
local end_hits = scan_exact_pointer("REGISTRY_END_EXCLUSIVE", end_exclusive)

-- Common vector/header layouts: {begin,end} and {begin,end,capacity}.
local pair_hits = scan_pair(
    "REGISTRY_BEGIN_END",
    start_addr,
    end_exclusive
)

-- If we found a likely header, follow exactly one pointer layer by
-- searching for pointers to that header. No recursion.
local header_candidates = {}

for _, hit in ipairs(pair_hits) do
    header_candidates[#header_candidates + 1] = hit
end

if #header_candidates == 0 then
    -- A lone start pointer can still be a header member; retain only candidates
    -- that also have end_exclusive nearby within +/- 32 bytes.
    for _, hit in ipairs(start_hits) do
        for off = -32, 32, 8 do
            local q = read_u64(hit + off)
            if q == end_exclusive then
                header_candidates[#header_candidates + 1] = hit
                log(string.format(
                    "HEADER_CANDIDATE via_start=0x%X end_offset=%d",
                    hit,
                    off
                ))
                break
            end
        end
    end
end

log(string.format(
    "HEADER_CANDIDATES count=%d",
    #header_candidates
))

for i, header in ipairs(header_candidates) do
    log(string.format(
        "HEADER index=%d addr=0x%X",
        i,
        header
    ))

    local parents = cfb.aob_scan(
        pointer_pattern(header),
        64
    )

    log(string.format(
        "HEADER_PARENT_SCAN index=%d hits=%d",
        i,
        #parents
    ))

    for j, parent in ipairs(parents) do
        log(string.format(
            "HEADER_PARENT header_index=%d parent_index=%d addr=0x%X",
            i,
            j,
            parent
        ))

        for off = -24, 24, 8 do
            local q = read_u64(parent + off)
            if q ~= nil then
                log(string.format(
                    "  QWORD offset=%d value=0x%X",
                    off,
                    q
                ))
            end
        end
    end
end

log(string.format(
    "SUMMARY count=%d target_index=%d start_ptr_hits=%d end_ptr_hits=%d pair_hits=%d header_candidates=%d",
    count,
    target_index,
    #start_hits,
    #end_hits,
    #pair_hits,
    #header_candidates
))

log("END")
