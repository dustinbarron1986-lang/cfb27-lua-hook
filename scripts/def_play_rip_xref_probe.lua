-- Read-only candidate finder, not a disassembler or a defensive-play reader.
-- Run this file repeatedly to advance; no tick callbacks are installed.
-- Reset explicitly with: _G.__def_play_rip_xref_v1 = nil
-- Only common unprefixed / single-REX LEA and MOV-load forms are recognized.
-- Candidate boundaries must be validated before considering a breakpoint.
local KEY = "__def_play_rip_xref_v1"
local BATCH = 0x10000
local MAX_REPORTS = 8
local TAG = "[def-play-xref] "
local TARGETS = {
    { name = "GETDEFPLAYGROUP", rva = 0x0B69CFA0 },
    { name = "GETDEFOFFSETTYPE", rva = 0x0B69D370 },
    { name = "SETPLAYGROUP", rva = 0x0B69CE58 },
    { name = "SETPLAY", rva = 0x0B69CE68 }
}

local function log(s) cfb.log(TAG .. s) end
local function byte(a)
    local ok, v = pcall(cfb.read_u8, a)
    if ok and math.type(v) == "integer" and v >= 0 and v <= 255 then
        return v
    end
    return nil
end
local function uint(a, n)
    local v = 0
    for i = 0, n - 1 do
        local b = byte(a + i)
        if b == nil then return nil end
        v = v | (b << (8 * i))
    end
    return v
end
local function need(a, n)
    local v = uint(a, n)
    assert(v ~= nil, string.format("unreadable header at 0x%X", a))
    return v
end
local function hex(a, n)
    local out = {}
    for i = 0, n - 1 do
        local b = byte(a + i)
        out[#out + 1] = b and string.format("%02X", b) or "??"
    end
    return table.concat(out, " ")
end
local function verify_targets(base, size)
    for _, t in ipairs(TARGETS) do
        assert(t.rva + #t.name + 1 <= size, "target outside image: " .. t.name)
        for i = 1, #t.name + 1 do
            local expected = i <= #t.name and string.byte(t.name, i) or 0
            assert(byte(base + t.rva + i - 1) == expected,
                "target bytes changed/unreadable: " .. t.name)
        end
    end
end
local function initialize(base)
    assert(need(base, 2) == 0x5A4D, "missing MZ header")
    local pe = need(base + 0x3C, 4)
    assert(pe >= 0x40 and pe <= 0x100000, "invalid PE offset")
    pe = base + pe
    assert(need(pe, 4) == 0x4550, "missing PE signature")
    assert(need(pe + 4, 2) == 0x8664, "not AMD64")
    local count, opt_size = need(pe + 6, 2), need(pe + 20, 2)
    assert(count > 0 and count <= 96 and opt_size >= 0x70,
        "invalid section/optional-header dimensions")
    local opt = pe + 24
    assert(need(opt, 2) == 0x20B, "not PE32+")
    local size, headers = need(opt + 56, 4), need(opt + 60, 4)
    local table_start = opt + opt_size
    assert(size > 0 and size <= 0x80000000 and headers <= size
        and table_start + count * 40 <= base + headers, "invalid image bounds")
    verify_targets(base, size)
    local sections, total = {}, 0
    for i = 0, count - 1 do
        local h = table_start + i * 40
        local length, rva, flags = need(h + 8, 4), need(h + 12, 4), need(h + 36, 4)
        if (flags & 0x20000000) ~= 0 then
            if length == 0 then length = need(h + 16, 4) end
            assert(rva >= headers and rva + length <= size, "invalid executable section")
            if length > 0 then
                sections[#sections + 1] = { first = base + rva, last = base + rva + length }
                total = total + length
            end
        end
    end
    table.sort(sections, function(a, b) return a.first < b.first end)
    assert(#sections > 0, "no executable sections")
    for i = 2, #sections do
        assert(sections[i].first >= sections[i - 1].last, "overlapping executable sections")
    end
    local s = { base = base, size = size, sections = sections, section = 1,
        cursor = sections[1].first, total = total, visited = 0,
        unreadable = 0, incomplete = 0, exact = 0, pool = 0, done = false }
    log(string.format("BEGIN base=0x%X executable_bytes=%d sections=%d batch=%d",
        base, total, #sections, BATCH))
    for _, t in ipairs(TARGETS) do
        log(string.format("TARGET %s=0x%X", t.name, base + t.rva))
    end
    return s
end

local function main()
    local base = cfb.module_base()
    local s = rawget(_G, KEY)
    if s == nil then
        s = initialize(base)
        rawset(_G, KEY, s)
    else
        assert(s.base == base, "module changed; reset probe state")
        verify_targets(base, s.size)
    end
    if s.done then
        log("Already finished; reset probe state explicitly to rescan.")
        return
    end
    local used, reports = 0, 0
    local gap_first, gap_last
    local function flush_gap()
        if gap_first then
            log(string.format("UNREADABLE 0x%X..0x%X", gap_first, gap_last))
            gap_first, gap_last = nil, nil
            reports = reports + 1
        end
    end
    while used < BATCH and reports < MAX_REPORTS and s.section <= #s.sections do
        local section = s.sections[s.section]
        local a = s.cursor
        if a >= section.last then
            flush_gap()
            s.section = s.section + 1
            if s.sections[s.section] then s.cursor = s.sections[s.section].first end
        else
            local first = byte(a)
            if first == nil then
                gap_first = gap_first or a
                gap_last = a
                s.unreadable = s.unreadable + 1
            else
                flush_gap()
                -- Bytewise discovery deliberately accepts possible instruction tails.
                -- A REX form may also yield an unprefixed candidate one byte later.
                local rex = first >= 0x40 and first <= 0x4F
                local op_at = a + (rex and 1 or 0)
                local op = rex and byte(op_at) or first
                local length = rex and 7 or 6
                if (op == 0x8D or op == 0x8B) and a + length <= section.last then
                    local modrm = byte(op_at + 1)
                    if modrm == nil then
                        s.incomplete = s.incomplete + 1
                    elseif (modrm & 0xC7) == 0x05 then
                        local disp = uint(op_at + 2, 4)
                        if disp == nil then
                            s.incomplete = s.incomplete + 1
                        else
                            if disp >= 0x80000000 then disp = disp - 0x100000000 end
                            local target = a + length + disp
                            local name
                            for _, t in ipairs(TARGETS) do
                                if target == base + t.rva then name = t.name; break end
                            end
                            if name or (target >= base + 0x0B69CC00
                                and target < base + 0x0B69D800) then
                                if name then s.exact = s.exact + 1 else s.pool = s.pool + 1 end
                                log(string.format("CANDIDATE %s %s at=0x%X rva=0x%X target=0x%X bytes=%s",
                                    name and "EXACT" or "POOL", name or "name-pool",
                                    a, a - base, target, hex(a, length)))
                                local start = math.max(section.first, a - 16)
                                log(string.format("CONTEXT 0x%X %s", start,
                                    hex(start, math.min(48, section.last - start))))
                                reports = reports + 1
                            end
                        end
                    end
                end
            end
            s.cursor = a + 1
            s.visited = s.visited + 1
            used = used + 1
        end
    end
    flush_gap()
    s.done = s.section > #s.sections
        or (s.section == #s.sections and s.cursor >= s.sections[s.section].last)
    log(string.format("%s visited=%d/%d unreadable=%d incomplete=%d exact=%d pool=%d next=0x%X",
        s.done and "DONE" or "PROGRESS", s.visited, s.total, s.unreadable,
        s.incomplete, s.exact, s.pool, s.cursor))
    if s.done then
        log("Coverage: common LEA/MOV-load byte patterns only; boundaries unverified. Zero candidates does not rule out indexed metadata or other encodings.")
    end
end

local ok, err = pcall(main)
if not ok then log("STOP " .. tostring(err)) end
